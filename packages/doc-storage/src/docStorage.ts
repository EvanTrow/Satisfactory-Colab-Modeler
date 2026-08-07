// Server-side load/write/compaction logic for the Yjs<->Postgres persistence
// split described in PLAN.md §4 "Canvas state: snapshot + incremental log".
//
// Deliberately transport-agnostic: every function here takes/returns plain
// bytes (`Uint8Array`/`Buffer`) and project ids, with no Fastify/Hocuspocus
// types anywhere in this file. Job 015 built this inside `apps/api` (as
// `apps/api/src/projects/docStorage.ts`) with a note flagging that Job 020
// would likely want it from `apps/realtime` too; Job 020 promoted it
// verbatim into this package for exactly that reason — see this package's
// `index.ts` header comment for the full architectural reasoning. Both
// `apps/api/src/projects/docRoutes.ts` (REST load/push/versions) and
// `apps/realtime/src/server.ts` (Hocuspocus `onLoadDocument`/
// `onStoreDocument`) call these same functions now — neither reimplements
// the merge/compaction algorithm.
import { sql } from "kysely";
import * as Y from "yjs";

import type { ProjectVersion } from "@scm/db";

import { db } from "./db.js";

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
 *
 * Job 016: every time compaction actually runs (folds ≥1 log row), an
 * `'auto'` `project_versions` snapshot is also taken — "an 'auto' snapshot
 * on some reasonable cadence (e.g. every N minutes of activity, or every
 * compaction — use judgement)" per that job's Scope. Piggybacking on
 * compaction (rather than a separate timer/cron) reuses the existing
 * threshold-based cadence with no new infrastructure, and means an auto
 * snapshot is only ever taken when there was real, already-durable content
 * to snapshot. Best-effort: a failure here is logged, not thrown — the
 * append and the compaction it triggered have already durably succeeded by
 * this point, and a missed auto-snapshot is not worth failing the request
 * over (unlike compaction itself, which nothing here currently guards
 * either — see this function's own pre-existing "logged but does not fail"
 * comment above, which was aspirational until this job; kept consistent by
 * not tightening compactProject's own error handling here).
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
    const compaction = await compactProject(projectId);
    if (compaction) {
      try {
        await createProjectVersion(projectId, { kind: "auto", createdBy: actorUserId });
      } catch (err) {
        console.error(`[docStorage] failed to create auto version snapshot for project ${projectId}`, err);
      }
    }
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

/** `project_versions` kinds, matching the table's check constraint. */
export type ProjectVersionKind = "auto" | "manual" | "import" | "pre_restore";

/**
 * A `project_versions` row without its `ydoc` bytes — what the version-list
 * UI needs (Job 016). `createdAt` reuses `ProjectVersion["created_at"]`
 * (from `@scm/db`'s `Selectable<ProjectVersionsTable>`) rather than
 * asserting `Date`/`string` directly — same pattern `routes.ts`'s
 * `SerializedProject.createdAt: Project["created_at"]` already uses, and
 * for the same reason: `db/schema.ts` declares timestamp columns as
 * `Generated<ColumnType<Date, string | Date | undefined, never>>`, and
 * `Generated<T>`'s own definition (`ColumnType<T, T | undefined, T>`)
 * double-wraps when `T` is already a `ColumnType` — `SelectType<>` only
 * unwraps one layer, so a *literal* `Date` annotation here would mismatch
 * the actually-inferred (still-partially-wrapped) select type. Deriving the
 * field's type from the table instead of asserting it sidesteps the
 * mismatch entirely, same as `routes.ts` already does.
 */
export interface ProjectVersionSummary {
  id: string;
  label: string | null;
  kind: ProjectVersionKind;
  createdBy: string | null;
  createdAt: ProjectVersion["created_at"];
}

/**
 * Inserts a `project_versions` row for `projectId`, snapshotting its current
 * merged document state, and returns the inserted row's metadata (not the
 * `ydoc` bytes — callers that need those should use `getProjectVersionBytes`).
 * `kind` matches the table's check constraint (`'auto' | 'manual' | 'import'
 * | 'pre_restore'`).
 *
 * Job 015 left this with zero callers ("having the table and an insert path
 * ready" was that job's whole scope). Job 016 is the first real caller:
 * `appendUpdate` above (kind `'auto'`, piggybacked on compaction),
 * `docRoutes.ts`'s manual "Save version" route (kind `'manual'`), and
 * `restoreProjectVersion` below (kind `'pre_restore'`, the safety snapshot
 * taken *before* a restore overwrites current state).
 */
export async function createProjectVersion(
  projectId: string,
  options: { label?: string | null; kind: ProjectVersionKind; createdBy?: string | null },
): Promise<ProjectVersionSummary> {
  const { doc } = await loadProjectDoc(projectId);
  const ydoc = Buffer.from(Y.encodeStateAsUpdate(doc));

  const row = await db
    .insertInto("project_versions")
    .values({
      project_id: projectId,
      ydoc,
      label: options.label ?? null,
      kind: options.kind,
      created_by: options.createdBy ?? null,
    })
    .returning(["id", "label", "kind", "created_by", "created_at"])
    .executeTakeFirstOrThrow();

  return { id: row.id, label: row.label, kind: row.kind as ProjectVersionKind, createdBy: row.created_by, createdAt: row.created_at };
}

/**
 * Lists a project's versions, newest first (matches `project_versions`'s own
 * `(project_id, created_at)` index) — the "list a project's versions
 * (timestamp, label, kind)" deliverable from Job 016's Scope. Deliberately
 * does not select `ydoc` (can be tens/hundreds of KB per row) — the list UI
 * never needs the bytes, only `getProjectVersionBytes`/`restoreProjectVersion`
 * do, once a specific version is chosen.
 */
export async function listProjectVersions(projectId: string): Promise<ProjectVersionSummary[]> {
  const rows = await db
    .selectFrom("project_versions")
    .select(["id", "label", "kind", "created_by", "created_at"])
    .where("project_id", "=", projectId)
    .orderBy("created_at", "desc")
    .execute();

  return rows.map((row) => ({ id: row.id, label: row.label, kind: row.kind as ProjectVersionKind, createdBy: row.created_by, createdAt: row.created_at }));
}

/**
 * Loads one version's raw `ydoc` bytes (`Y.encodeStateAsUpdate` as it was at
 * snapshot time), scoped to `projectId` so a version id from a *different*
 * project can never be read/restored cross-project. `null` if no such
 * version exists for this project.
 */
export async function getProjectVersionBytes(projectId: string, versionId: string): Promise<Uint8Array | null> {
  const row = await db
    .selectFrom("project_versions")
    .select(["ydoc"])
    .where("project_id", "=", projectId)
    .where("id", "=", versionId)
    .executeTakeFirst();

  return row ? new Uint8Array(row.ydoc) : null;
}

/** What a successful `restoreProjectVersion` did, for the route/tests. */
export interface RestoreResult {
  /** The safety snapshot of current (pre-restore) state, taken before the overwrite — see this function's doc comment. */
  preRestoreVersion: ProjectVersionSummary;
  /** Echoes the id that was restored, for the caller's convenience. */
  restoredVersionId: string;
}

/**
 * Restores `versionId`'s content as `projectId`'s new current document
 * state — Job 016's "restoring one creates a new `kind: 'pre_restore'`
 * snapshot of current state first..., then applies the selected version's
 * `ydoc` bytes as the new current state."
 *
 * Returns `null` (no-op, nothing written) if `versionId` doesn't exist for
 * this project.
 *
 * **This is a wholesale replace, not a merge** — see this job's own Handoff
 * guidance (and Job 015's handoff notes on the same gotcha): two
 * independent `Y.Doc`s that each wrote the same key are, from Yjs's
 * perspective, truly causally-concurrent, with "who wins" decided by each
 * write's `(client, clock)` id, *not* by which one was persisted later. If
 * restoring just `Y.applyUpdate`-d the version's bytes into the *current*
 * live snapshot+log, an old node deleted in state B (the current state)
 * but present in the restored version A would silently come back merged
 * alongside B's other content — a union, not a rollback. Instead, this
 * builds a **fresh** `Y.Doc`, applies *only* the restored version's bytes
 * to it, and writes that as the new `project_doc_state` snapshot — so
 * "restored version becomes current" is unambiguous, matching how
 * `duplicateDocState` above treats a copy as a fresh independent snapshot,
 * not a merge.
 *
 * Every `project_doc_updates` row that existed before the restore is
 * discarded (their effect is folded into the *old* current state, which is
 * exactly what's being replaced) by setting the new snapshot's `seq` to the
 * highest existing log id (or the prior snapshot's `seq` if there were no
 * log rows) and deleting every row up to and including it — mirroring
 * `compactProject`'s own fold-and-delete shape, except the "fold" here
 * discards the log's content instead of merging it in.
 */
export async function restoreProjectVersion(
  projectId: string,
  versionId: string,
  actorUserId: string | null,
): Promise<RestoreResult | null> {
  const versionBytes = await getProjectVersionBytes(projectId, versionId);
  if (!versionBytes) {
    return null;
  }

  // Safety snapshot of current state *before* it's overwritten — "restoring
  // is itself non-destructive/undoable at the version-history level" per
  // the job file. Taken outside the transaction below (reads current
  // snapshot+log via the ordinary `loadProjectDoc` path, same as any other
  // `createProjectVersion` call) so it reflects state as of *now*, not
  // whatever's left after the transaction below discards the log.
  const preRestoreVersion = await createProjectVersion(projectId, {
    kind: "pre_restore",
    createdBy: actorUserId,
    label: `Before restoring "${versionId}"`,
  });

  await db.transaction().execute(async (trx) => {
    const maxLogRow = await trx
      .selectFrom("project_doc_updates")
      .select(sql<string | null>`max(id)::text`.as("maxId"))
      .where("project_id", "=", projectId)
      .executeTakeFirst();

    const priorSnapshot = await trx
      .selectFrom("project_doc_state")
      .select(["seq"])
      .where("project_id", "=", projectId)
      .forUpdate()
      .executeTakeFirst();

    const newSeq = maxLogRow?.maxId ?? priorSnapshot?.seq ?? "0";

    const freshDoc = new Y.Doc();
    Y.applyUpdate(freshDoc, versionBytes);
    const newYdoc = Buffer.from(Y.encodeStateAsUpdate(freshDoc));
    const newStateVector = Buffer.from(Y.encodeStateVector(freshDoc));

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

    await trx.deleteFrom("project_doc_updates").where("project_id", "=", projectId).where("id", "<=", newSeq).execute();
  });

  return { preRestoreVersion, restoredVersionId: versionId };
}
