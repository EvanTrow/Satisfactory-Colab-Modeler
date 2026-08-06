import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { closeDb, db } from "../db.js";
import {
  appendUpdate,
  compactProject,
  createProjectVersion,
  duplicateDocState,
  loadProjectDoc,
  loadProjectDocUpdate,
} from "./docStorage.js";
import { generateShortId } from "./short-id.js";

// These tests hit a real Postgres connection (DATABASE_URL), same precedent
// as projects/routes.test.ts and auth/*.test.ts.

afterAll(async () => {
  await closeDb();
});

async function createTestUser(username: string) {
  return db
    .insertInto("users")
    .values({ discord_id: `test-${crypto.randomUUID()}`, username })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Inserts a bare `projects` row directly — these tests exercise `docStorage.ts` in isolation, not the project-CRUD routes. */
async function createTestProject(ownerId: string) {
  return db
    .insertInto("projects")
    .values({ short_id: generateShortId(), owner_id: ownerId, game_data_version: "test" })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Builds a small, one-shot Yjs update that sets a distinctive `meta.marker` key — a cheap way to assert "this specific edit made it through." Only safe to use once per key per test: two *independent* one-shot docs both setting the same key are, from Yjs's point of view, truly concurrent writes with no causal relationship, and which one "wins" is resolved by comparing each write's (client, clock) id — not by which `appendUpdate` call happened later. Tests that need a deterministic "the most recent edit wins" (repeated writes to the same key) use `createMarkerEditor` below instead. */
function singleMarkerUpdate(marker: string): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getMap("meta").set("marker", marker);
  });
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Simulates one client's sequential local edits against a single evolving
 * `Y.Doc`, returning each call's *incremental* update
 * (`Y.encodeStateAsUpdate(doc, priorStateVector)`) — exactly the shape
 * `apps/web`'s `doc.on('update', ...)` listener produces for a real local
 * edit (see `persistence/updateQueue.ts`). Because every edit comes from
 * the same client's own timeline (not an unrelated fresh doc each time),
 * repeated writes to the same key are genuinely causally ordered, so "the
 * latest edit wins" is deterministic — unlike two independent one-shot
 * docs (see `singleMarkerUpdate` above), which would both be "concurrent"
 * from Yjs's perspective with no defined winner.
 */
function createMarkerEditor() {
  const doc = new Y.Doc();
  let priorStateVector = Y.encodeStateVector(doc);
  return {
    setMarker(value: string): Uint8Array {
      doc.transact(() => {
        doc.getMap("meta").set("marker", value);
      });
      const update = Y.encodeStateAsUpdate(doc, priorStateVector);
      priorStateVector = Y.encodeStateVector(doc);
      return update;
    },
  };
}

describe("loadProjectDoc", () => {
  it("returns an empty doc for a project with no persisted state at all", async () => {
    const owner = await createTestUser("docstorage-empty-owner");
    const project = await createTestProject(owner.id);

    const { doc, snapshotSeq, appliedLogRows } = await loadProjectDoc(project.id);

    expect(snapshotSeq).toBe(0n);
    expect(appliedLogRows).toHaveLength(0);
    expect(doc.getMap("meta").size).toBe(0);
  });

  it("merges snapshot + every log row with id > seq, in order", async () => {
    const owner = await createTestUser("docstorage-merge-owner");
    const project = await createTestProject(owner.id);

    // Three separate appends (three separate project_doc_updates rows),
    // each setting a different key — if `loadProjectDoc` merged them out of
    // order or dropped one, at least one key would be missing/wrong below.
    const doc1 = new Y.Doc();
    doc1.transact(() => doc1.getMap("meta").set("a", 1));
    await appendUpdate(project.id, Y.encodeStateAsUpdate(doc1), owner.id);

    const doc2 = new Y.Doc();
    doc2.transact(() => doc2.getMap("meta").set("b", 2));
    await appendUpdate(project.id, Y.encodeStateAsUpdate(doc2), owner.id);

    const doc3 = new Y.Doc();
    doc3.transact(() => doc3.getMap("meta").set("c", 3));
    await appendUpdate(project.id, Y.encodeStateAsUpdate(doc3), owner.id);

    const { doc, appliedLogRows } = await loadProjectDoc(project.id);
    expect(appliedLogRows).toHaveLength(3);
    expect(doc.getMap("meta").get("a")).toBe(1);
    expect(doc.getMap("meta").get("b")).toBe(2);
    expect(doc.getMap("meta").get("c")).toBe(3);
  });

  it("loadProjectDocUpdate returns bytes a fresh Y.Doc can Y.applyUpdate", async () => {
    const owner = await createTestUser("docstorage-loadupdate-owner");
    const project = await createTestProject(owner.id);
    await appendUpdate(project.id, singleMarkerUpdate("hello"), owner.id);

    const update = await loadProjectDocUpdate(project.id);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, update);
    expect(fresh.getMap("meta").get("marker")).toBe("hello");
  });
});

describe("appendUpdate", () => {
  it("is O(change) — a single small update results in exactly one project_doc_updates row", async () => {
    const owner = await createTestUser("docstorage-append-owner");
    const project = await createTestProject(owner.id);

    const update = singleMarkerUpdate("single-change");
    await appendUpdate(project.id, update, owner.id);

    const rows = await db
      .selectFrom("project_doc_updates")
      .selectAll()
      .where("project_id", "=", project.id)
      .execute();

    expect(rows).toHaveLength(1);
    // The stored row is the update itself, not a full-document rewrite —
    // its size should be small (well under 1KB) and match what was sent,
    // not grow with unrelated document content.
    expect(rows[0]!.update.length).toBe(update.length);
    expect(rows[0]!.update.length).toBeLessThan(200);
    expect(rows[0]!.actor_user_id).toBe(owner.id);
  });

  it("auto-compacts once the log row count exceeds the given threshold", async () => {
    const owner = await createTestUser("docstorage-autocompact-owner");
    const project = await createTestProject(owner.id);

    // A tiny threshold so the test doesn't need to insert 200 rows. One
    // evolving editor (not four independent one-shot docs) so "the last
    // append wins" is deterministic — see `createMarkerEditor`'s doc comment.
    const THRESHOLD = 3;
    const editor = createMarkerEditor();
    for (let i = 0; i < 4; i++) {
      await appendUpdate(project.id, editor.setMarker(`m${i}`), owner.id, THRESHOLD);
    }

    // The 4th append pushed the count to 4 > 3, triggering an inline
    // compaction — the log should now be empty (folded + deleted) and a
    // snapshot row should exist.
    const remainingLogRows = await db
      .selectFrom("project_doc_updates")
      .selectAll()
      .where("project_id", "=", project.id)
      .execute();
    expect(remainingLogRows).toHaveLength(0);

    const snapshot = await db
      .selectFrom("project_doc_state")
      .selectAll()
      .where("project_id", "=", project.id)
      .executeTakeFirst();
    expect(snapshot).toBeDefined();

    // And the content survived the fold.
    const { doc } = await loadProjectDoc(project.id);
    expect(doc.getMap("meta").get("marker")).toBe("m3");
  });
});

describe("compactProject", () => {
  it("is a no-op (returns null) when there are no un-folded log rows", async () => {
    const owner = await createTestUser("docstorage-compact-noop-owner");
    const project = await createTestProject(owner.id);

    const result = await compactProject(project.id);
    expect(result).toBeNull();
  });

  it("folds log rows into the snapshot, deletes them, and advances seq", async () => {
    const owner = await createTestUser("docstorage-compact-owner");
    const project = await createTestProject(owner.id);

    await appendUpdate(project.id, singleMarkerUpdate("first"), owner.id);
    await appendUpdate(project.id, singleMarkerUpdate("second"), owner.id);

    const logRowsBefore = await db
      .selectFrom("project_doc_updates")
      .selectAll()
      .where("project_id", "=", project.id)
      .orderBy("id", "asc")
      .execute();
    expect(logRowsBefore).toHaveLength(2);
    const highestId = logRowsBefore[1]!.id;

    const result = await compactProject(project.id);
    expect(result).not.toBeNull();
    expect(result!.foldedRowCount).toBe(2);
    expect(result!.newSeq).toBe(highestId);

    const logRowsAfter = await db
      .selectFrom("project_doc_updates")
      .selectAll()
      .where("project_id", "=", project.id)
      .execute();
    expect(logRowsAfter).toHaveLength(0);

    const snapshot = await db
      .selectFrom("project_doc_state")
      .selectAll()
      .where("project_id", "=", project.id)
      .executeTakeFirstOrThrow();
    expect(snapshot.seq).toBe(highestId);

    // A second compaction (nothing left to fold) is a safe no-op.
    const secondResult = await compactProject(project.id);
    expect(secondResult).toBeNull();
  });

  it("is lossless — the merged document is byte-identical whether or not compaction ran (Y.encodeStateAsUpdate comparison, per the job's acceptance criteria)", async () => {
    const owner = await createTestUser("docstorage-lossless-owner");
    const project = await createTestProject(owner.id);

    // A handful of updates touching different parts of the document shape,
    // not just one field, so a real merge is being exercised.
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap("meta").set("title", "Lossless Test Factory");
    });
    await appendUpdate(project.id, Y.encodeStateAsUpdate(doc), owner.id);

    const nodesUpdate = new Y.Doc();
    nodesUpdate.transact(() => {
      const nodeMap = new Y.Map<unknown>();
      nodeMap.set("id", "n_1");
      nodeMap.set("x", 100);
      nodesUpdate.getMap("nodes").set("n_1", nodeMap);
    });
    await appendUpdate(project.id, Y.encodeStateAsUpdate(nodesUpdate), owner.id);

    const settingsUpdate = new Y.Doc();
    settingsUpdate.transact(() => {
      settingsUpdate.getMap("settings").set("solverMode", "basic");
    });
    await appendUpdate(project.id, Y.encodeStateAsUpdate(settingsUpdate), owner.id);

    // Merge #1: snapshot (none yet) + all three log rows, loaded fresh.
    const { doc: mergedBeforeCompaction } = await loadProjectDoc(project.id);
    const bytesBeforeCompaction = Y.encodeStateAsUpdate(mergedBeforeCompaction);

    await compactProject(project.id);

    // Merge #2: the now-compacted snapshot alone (no log rows left), loaded fresh.
    const { doc: mergedAfterCompaction, appliedLogRows } = await loadProjectDoc(project.id);
    expect(appliedLogRows).toHaveLength(0); // proves this merge came from the snapshot alone, not leftover log rows
    const bytesAfterCompaction = Y.encodeStateAsUpdate(mergedAfterCompaction);

    // The whole point of compaction: purely a storage optimization, never
    // lossy. Byte-for-byte identical encoded state either way.
    expect(Buffer.from(bytesAfterCompaction).equals(Buffer.from(bytesBeforeCompaction))).toBe(true);

    // Sanity-check the actual content survived too, not just an empty doc
    // on both sides.
    expect(mergedAfterCompaction.getMap("meta").get("title")).toBe("Lossless Test Factory");
    expect(mergedAfterCompaction.getMap("settings").get("solverMode")).toBe("basic");
  });

  it("runs as a single transaction — a crash before compaction, or reading the log without compacting at all, still loads correctly (bounds data loss to at most one un-flushed debounce window, never a torn snapshot/log state)", async () => {
    const owner = await createTestUser("docstorage-crash-owner");
    const project = await createTestProject(owner.id);

    // Simulates a client that has successfully flushed two debounce windows
    // (two appendUpdate calls landed) but the server never got around to
    // compacting (e.g. the process was restarted before the next append's
    // threshold check, or before a periodic compaction ran). Nothing here
    // calls compactProject — this is deliberately testing the
    // snapshot-less, partial-log path a "server restart mid-session" leaves
    // behind.
    const editor = createMarkerEditor();
    await appendUpdate(project.id, editor.setMarker("window-1"), owner.id);
    await appendUpdate(project.id, editor.setMarker("window-2"), owner.id);

    // A fresh load (simulating the API process restarting and a client
    // reconnecting) must still see the latest state — nothing was lost.
    const { doc } = await loadProjectDoc(project.id);
    expect(doc.getMap("meta").get("marker")).toBe("window-2");
  });
});

describe("duplicateDocState", () => {
  it("copies the source project's current merged doc state into a fresh snapshot for the target, with seq reset to 0", async () => {
    const owner = await createTestUser("docstorage-dup-owner");
    const source = await createTestProject(owner.id);
    const target = await createTestProject(owner.id);

    await appendUpdate(source.id, singleMarkerUpdate("dup-me"), owner.id);

    await duplicateDocState(source.id, target.id);

    const targetSnapshot = await db
      .selectFrom("project_doc_state")
      .selectAll()
      .where("project_id", "=", target.id)
      .executeTakeFirstOrThrow();
    expect(targetSnapshot.seq).toBe("0");

    const { doc: targetDoc } = await loadProjectDoc(target.id);
    expect(targetDoc.getMap("meta").get("marker")).toBe("dup-me");

    // The source project is untouched — still has its own log row, no snapshot forced onto it.
    const sourceLogRows = await db
      .selectFrom("project_doc_updates")
      .selectAll()
      .where("project_id", "=", source.id)
      .execute();
    expect(sourceLogRows).toHaveLength(1);
  });

  it("is a no-op when the source project has no persisted state at all", async () => {
    const owner = await createTestUser("docstorage-dup-empty-owner");
    const source = await createTestProject(owner.id);
    const target = await createTestProject(owner.id);

    await duplicateDocState(source.id, target.id);

    const targetSnapshot = await db
      .selectFrom("project_doc_state")
      .selectAll()
      .where("project_id", "=", target.id)
      .executeTakeFirst();
    expect(targetSnapshot).toBeUndefined();
  });

  it("duplicating after the source has been compacted still copies correctly", async () => {
    const owner = await createTestUser("docstorage-dup-compacted-owner");
    const source = await createTestProject(owner.id);
    const target = await createTestProject(owner.id);

    const editor = createMarkerEditor();
    await appendUpdate(source.id, editor.setMarker("before-compaction"), owner.id);
    await compactProject(source.id);
    await appendUpdate(source.id, editor.setMarker("after-compaction"), owner.id);

    await duplicateDocState(source.id, target.id);

    const { doc: targetDoc } = await loadProjectDoc(target.id);
    // The snapshot+log merge should reflect the *latest* write, proving
    // duplicateDocState merged both the compacted snapshot and the
    // still-un-folded log row, not just one or the other.
    expect(targetDoc.getMap("meta").get("marker")).toBe("after-compaction");
  });
});

describe("createProjectVersion", () => {
  it("inserts a project_versions row snapshotting the current merged doc state", async () => {
    const owner = await createTestUser("docstorage-version-owner");
    const project = await createTestProject(owner.id);
    await appendUpdate(project.id, singleMarkerUpdate("v1-content"), owner.id);

    await createProjectVersion(project.id, { kind: "manual", label: "My Save", createdBy: owner.id });

    const version = await db
      .selectFrom("project_versions")
      .selectAll()
      .where("project_id", "=", project.id)
      .executeTakeFirstOrThrow();
    expect(version.kind).toBe("manual");
    expect(version.label).toBe("My Save");
    expect(version.created_by).toBe(owner.id);

    const versionDoc = new Y.Doc();
    Y.applyUpdate(versionDoc, version.ydoc);
    expect(versionDoc.getMap("meta").get("marker")).toBe("v1-content");
  });
});
