// Server-side load/write/compaction logic for the Yjs<->Postgres persistence
// split described in PLAN.md §4 "Canvas state: snapshot + incremental log".
//
// Deliberately transport-agnostic: every function here takes/returns plain
// bytes (`Uint8Array`/`Buffer`) and project ids, with no Fastify types
// anywhere in this file. `apps/api/src/projects/docRoutes.ts` is the only
// caller today, but Job 020 (Hocuspocus, `apps/realtime`) is expected to
// reuse this exact module for its own `onLoadDocument`/`onStoreDocument`
// hooks rather than re-implementing the same merge/compaction algorithm — see
// this job's own Notes section ("Keep the persistence module's interface
// transport-agnostic..."). If `apps/realtime` ends up in its own workspace
// package with no dependency on `apps/api`, promoting this file (verbatim)
// to a new `packages/doc-storage` (or similar) is the expected move — not
// done here since only one caller exists so far and PLAN.md doesn't name a
// package for it.
import { sql } from "kysely";
import * as Y from "yjs";

import { db } from "../db.js";

/**
 * Fold the log into the snapshot once a project's `project_doc_updates` row
 * count exceeds this many. PLAN.md §4: "A background job folds logs into
 * the snapshot once the log exceeds ~200 rows." Configurable per-call (see
 * `appendUpdate`) so tests can exercise compaction without inserting 200
 * rows; defaults to PLAN.md's own number everywhere else.
 */
export const DEFAULT_COMPACTION_THRESHOLD = 200;

/** A resolved, in-memory `Y.Doc` for a project, plus the log-row bookkeeping needed to compact it. */
export interface LoadedProjectDoc {
  doc: Y.Doc;
  /** The snapshot's `seq` as loaded (0n if the project has no `project_doc_state` row yet). */
  snapshotSeq: bigint;
  /** Log rows with `id > snapshotSeq`, in ascending `id` order — already applied to `doc`. */
  appliedLogRows: { id: bigint }[];
}

/**
 * Loads a project's document: the compacted snapshot (if any) plus every
 * `project_doc_updates` row with `id > seq`, merged via `Y.applyUpdate` in
 * ascending `id` order — exactly PLAN.md §4's "Load = snapshot + every log
 * row with `id > seq`, merged." Returns a *fresh* `Y.Doc` — callers that
 * want to reuse it across multiple operations (e.g. `compactProject` below)
 * should hold onto the returned value rather than calling this twice.
 *
 * A project with no snapshot and no log rows at all (never opened, or
 * opened but never edited) resolves to an empty `Y.Doc()` — not an error.
 * `apps/web`'s `createDocument({ doc })` treats an empty doc as "populate
 * the default meta/settings," so this is the correct "nothing persisted
 * yet" representation, not a special case callers need to branch on.
 */
export async function loadProjectDoc(projectId: string): Promise<LoadedProjectDoc> {
  const doc = new Y.Doc();

  const snapshot = await db
    .selectFrom("project_doc_state")
    .select(["ydoc", "seq"])
    .where("project_id", "=", projectId)
    .executeTakeFirst();

  const snapshotSeq = snapshot ? BigInt(snapshot.seq) : 0n;

  if (snapshot) {
    Y.applyUpdate(doc, snapshot.ydoc);
  }

  const logRows = await db
    .selectFrom("project_doc_updates")
    .select(["id", "update"])
    .where("project_id", "=", projectId)
    .where("id", ">", snapshotSeq.toString())
    .orderBy("id", "asc")
    .execute();

  for (const row of logRows) {
    Y.applyUpdate(doc, row.update);
  }

  return {
    doc,
    snapshotSeq,
    appliedLogRows: logRows.map((row) => ({ id: BigInt(row.id) })),
  };
}

/**
 * Loads a project's merged document state and returns it as a single Yjs
 * update (`Y.encodeStateAsUpdate`) — what `GET /api/projects/:id/doc`
 * (`docRoutes.ts`) sends to the client for `Y.applyUpdate`-ing into a fresh
 * local doc.
 */
export async function loadProjectDocUpdate(projectId: string): Promise<Uint8Array> {
  const { doc } = await loadProjectDoc(projectId);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Appends one row to `project_doc_updates` — PLAN.md §4's "Write = append
 * one row (no rewriting the document)." Never touches `project_doc_state`
 * directly; this is the only durable effect of a debounced client flush.
 *
 * After inserting, checks whether this project's (un-folded) log row count
 * now exceeds `threshold` and, if so, compacts inline — "can be a simple
 * periodic/synchronous check... no need for a separate job queue" per this
 * job's own guidance. Compaction failure is logged but does not fail the
 * append itself (the update is already durably written by that point; a
 * missed compaction just means the log grows a little more before the next
 * append tries again).
 */
export async function appendUpdate(
  projectId: string,
  update: Uint8Array,
  actorUserId: string | null,
  threshold: number = DEFAULT_COMPACTION_THRESHOLD,
): Promise<void> {
  await db
    .insertInto("project_doc_updates")
    .values({
      project_id: projectId,
      update: Buffer.from(update),
      actor_user_id: actorUserId,
    })
    .execute();

  const { count } = await db
    .selectFrom("project_doc_updates")
    .select(db.fn.countAll<string>().as("count"))
    .where("project_id", "=", projectId)
    .executeTakeFirstOrThrow();

  if (Number(count) > threshold) {
    await compactProject(projectId);
  }
}

/** What `compactProject` did, for tests/logging. `null` means there was nothing to fold. */
export interface CompactionResult {
  projectId: string;
  /** The new snapshot's `seq` (the highest folded `project_doc_updates.id`). */
  newSeq: string;
  /** How many log rows were folded and deleted. */
  foldedRowCount: number;
}

/**
 * Folds every un-folded `project_doc_updates` row into `project_doc_state`,
 * then deletes those rows — PLAN.md §4's "A background job folds logs into
 * the snapshot once the log exceeds ~200 rows, then deletes them." Runs
 * inside a single transaction so a crash mid-compaction can never leave the
 * snapshot updated without the corresponding rows deleted (or vice versa) —
 * either the whole fold-and-delete happens, or none of it does, and a
 * concurrent `loadProjectDoc` call sees one consistent state or the other,
 * never a torn one.
 *
 * **Lossless by construction**: the new snapshot is `Y.encodeStateAsUpdate`
 * of a `Y.Doc` built by applying the *exact same* snapshot+log sequence
 * `loadProjectDoc` would apply — compaction only ever changes how that state
 * is stored (fewer, larger blobs instead of many small ones), never what
 * state it represents. Verified byte-for-byte in `docStorage.test.ts`
 * (`Y.encodeStateAsUpdate` before vs. after compaction, from two
 * independently-loaded docs).
 *
 * Returns `null` (no-op, no transaction opened) if there are no un-folded
 * log rows to fold — compacting an already-compact project is always safe
 * to call and does nothing.
 */
export async function compactProject(projectId: string): Promise<CompactionResult | null> {
  return db.transaction().execute(async (trx) => {
    const snapshot = await trx
      .selectFrom("project_doc_state")
      .select(["ydoc", "seq"])
      .where("project_id", "=", projectId)
      .forUpdate()
      .executeTakeFirst();

    const snapshotSeq = snapshot ? BigInt(snapshot.seq) : 0n;

    const logRows = await trx
      .selectFrom("project_doc_updates")
      .select(["id", "update"])
      .where("project_id", "=", projectId)
      .where("id", ">", snapshotSeq.toString())
      .orderBy("id", "asc")
      .execute();

    if (logRows.length === 0) {
      return null;
    }

    const doc = new Y.Doc();
    if (snapshot) {
      Y.applyUpdate(doc, snapshot.ydoc);
    }
    for (const row of logRows) {
      Y.applyUpdate(doc, row.update);
    }

    const newYdoc = Buffer.from(Y.encodeStateAsUpdate(doc));
    const newStateVector = Buffer.from(Y.encodeStateVector(doc));
    const newSeq = logRows[logRows.length - 1]!.id;

    await trx
      .insertInto("project_doc_state")
      .values({ project_id: projectId, ydoc: newYdoc, state_vector: newStateVector, seq: newSeq })
      .onConflict((oc) =>
        oc.column("project_id").doUpdateSet({
          ydoc: newYdoc,
          state_vector: newStateVector,
          seq: newSeq,
          compacted_at: sql`now()`,
        }),
      )
      .execute();

    await trx
      .deleteFrom("project_doc_updates")
      .where("project_id", "=", projectId)
      .where("id", "<=", newSeq)
      .execute();

    return { projectId, newSeq, foldedRowCount: logRows.length };
  });
}

/**
 * Seeds `target`'s `project_doc_state` with `source`'s current merged
 * document state (snapshot + logs), as of the moment this is called —
 * the fix for Job 006's `TODO(job-015)` on `store.ts`'s `duplicateProject`:
 * duplicating a project now duplicates its canvas content, not just its
 * metadata row.
 *
 * `target`'s new snapshot has `seq = "0"` — deliberately not `source`'s
 * `seq` or its own log state, since `target` starts with zero
 * `project_doc_updates` rows of its own; `seq` only ever means "the highest
 * *this project's own* log id folded into *this project's own* snapshot".
 *
 * Does nothing if `source` has no persisted state at all (never opened, or
 * opened but never edited) — there's nothing to copy, and `target` is left
 * exactly as fresh-project-with-no-doc-state, same as a normal `createProject`
 * would leave it (the client synthesizes an empty document either way — see
 * `loadProjectDoc`'s doc comment on the empty-doc case).
 */
export async function duplicateDocState(sourceProjectId: string, targetProjectId: string): Promise<void> {
  const { doc, snapshotSeq, appliedLogRows } = await loadProjectDoc(sourceProjectId);

  if (snapshotSeq === 0n && appliedLogRows.length === 0) {
    return;
  }

  const ydoc = Buffer.from(Y.encodeStateAsUpdate(doc));
  const stateVector = Buffer.from(Y.encodeStateVector(doc));

  await db
    .insertInto("project_doc_state")
    .values({ project_id: targetProjectId, ydoc, state_vector: stateVector, seq: "0" })
    .execute();
}

/**
 * Inserts a `project_versions` row for `projectId`, snapshotting its current
 * merged document state. Not called from anywhere yet — Job 015's scope is
 * "having the table and an insert path ready," per the job file; Job 016
 * builds the UI (manual "save a named version" + restore) that will call
 * this. `kind` matches the table's check constraint (`'auto' | 'manual' |
 * 'import' | 'pre_restore'`).
 */
export async function createProjectVersion(
  projectId: string,
  options: { label?: string | null; kind: "auto" | "manual" | "import" | "pre_restore"; createdBy?: string | null },
): Promise<void> {
  const { doc } = await loadProjectDoc(projectId);
  const ydoc = Buffer.from(Y.encodeStateAsUpdate(doc));

  await db
    .insertInto("project_versions")
    .values({
      project_id: projectId,
      ydoc,
      label: options.label ?? null,
      kind: options.kind,
      created_by: options.createdBy ?? null,
    })
    .execute();
}
