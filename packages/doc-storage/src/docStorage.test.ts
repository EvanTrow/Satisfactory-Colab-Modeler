import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { closeDb, db } from "./db.js";
import {
  appendUpdate,
  compactProject,
  createProjectVersion,
  deleteProjectVersion,
  duplicateDocState,
  getProjectVersionBytes,
  listProjectVersions,
  loadProjectDoc,
  loadProjectDocUpdate,
  restoreProjectVersion,
} from "./docStorage.js";

// These tests hit a real Postgres connection (DATABASE_URL), same precedent
// as apps/api's projects/routes.test.ts and auth/*.test.ts.

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

/**
 * Inserts a bare `projects` row directly — these tests exercise
 * `docStorage.ts` in isolation, not the project-CRUD routes, so this is a
 * minimal inline stand-in for `apps/api/src/projects/short-id.ts`'s
 * `generateShortId` (not imported: this package has no dependency on
 * `apps/api`, by this repo's own "apps don't import each other's `src/`"
 * convention — see this package's `index.ts`) rather than a real
 * collision-retry-worthy id generator.
 */
async function createTestProject(ownerId: string) {
  return db
    .insertInto("projects")
    .values({ short_id: crypto.randomUUID(), owner_id: ownerId, game_data_version: "test" })
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
  it("inserts a project_versions row snapshotting the current merged doc state, and returns its metadata", async () => {
    const owner = await createTestUser("docstorage-version-owner");
    const project = await createTestProject(owner.id);
    await appendUpdate(project.id, singleMarkerUpdate("v1-content"), owner.id);

    const returned = await createProjectVersion(project.id, { kind: "manual", label: "My Save", createdBy: owner.id });
    expect(returned.kind).toBe("manual");
    expect(returned.label).toBe("My Save");
    expect(returned.createdBy).toBe(owner.id);
    expect(typeof returned.id).toBe("string");

    const version = await db
      .selectFrom("project_versions")
      .selectAll()
      .where("id", "=", returned.id)
      .executeTakeFirstOrThrow();
    expect(version.project_id).toBe(project.id);
    expect(version.kind).toBe("manual");
    expect(version.label).toBe("My Save");
    expect(version.created_by).toBe(owner.id);

    const versionDoc = new Y.Doc();
    Y.applyUpdate(versionDoc, version.ydoc);
    expect(versionDoc.getMap("meta").get("marker")).toBe("v1-content");
  });
});

describe("listProjectVersions", () => {
  it("lists a project's versions newest first, without the ydoc bytes", async () => {
    const owner = await createTestUser("docstorage-listversions-owner");
    const project = await createTestProject(owner.id);
    await appendUpdate(project.id, singleMarkerUpdate("v1"), owner.id);

    const v1 = await createProjectVersion(project.id, { kind: "manual", label: "First", createdBy: owner.id });
    const v2 = await createProjectVersion(project.id, { kind: "auto", createdBy: null });

    const versions = await listProjectVersions(project.id);
    expect(versions).toHaveLength(2);
    // Newest first — v2 was created after v1.
    expect(versions[0]!.id).toBe(v2.id);
    expect(versions[1]!.id).toBe(v1.id);
    expect(versions[1]!.label).toBe("First");
    expect(versions[0]!.kind).toBe("auto");
    // No `ydoc` field leaks into the list shape.
    expect(versions[0]).not.toHaveProperty("ydoc");
  });

  it("returns an empty list for a project with no versions", async () => {
    const owner = await createTestUser("docstorage-listversions-empty-owner");
    const project = await createTestProject(owner.id);

    const versions = await listProjectVersions(project.id);
    expect(versions).toEqual([]);
  });
});

describe("getProjectVersionBytes", () => {
  it("returns the version's ydoc bytes, applyable to a fresh doc", async () => {
    const owner = await createTestUser("docstorage-versionbytes-owner");
    const project = await createTestProject(owner.id);
    await appendUpdate(project.id, singleMarkerUpdate("bytes-content"), owner.id);
    const version = await createProjectVersion(project.id, { kind: "manual", createdBy: owner.id });

    const bytes = await getProjectVersionBytes(project.id, version.id);
    expect(bytes).not.toBeNull();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes!);
    expect(doc.getMap("meta").get("marker")).toBe("bytes-content");
  });

  it("returns null for a nonexistent version id", async () => {
    const owner = await createTestUser("docstorage-versionbytes-missing-owner");
    const project = await createTestProject(owner.id);

    const bytes = await getProjectVersionBytes(project.id, crypto.randomUUID());
    expect(bytes).toBeNull();
  });

  it("returns null when the version belongs to a different project (scoped lookup)", async () => {
    const owner = await createTestUser("docstorage-versionbytes-crossproject-owner");
    const projectA = await createTestProject(owner.id);
    const projectB = await createTestProject(owner.id);
    await appendUpdate(projectA.id, singleMarkerUpdate("a-content"), owner.id);
    const version = await createProjectVersion(projectA.id, { kind: "manual", createdBy: owner.id });

    const bytes = await getProjectVersionBytes(projectB.id, version.id);
    expect(bytes).toBeNull();
  });
});

describe("restoreProjectVersion", () => {
  it("returns null for a nonexistent version id, without creating a pre_restore snapshot", async () => {
    const owner = await createTestUser("docstorage-restore-missing-owner");
    const project = await createTestProject(owner.id);

    const result = await restoreProjectVersion(project.id, crypto.randomUUID(), owner.id);
    expect(result).toBeNull();

    const versions = await listProjectVersions(project.id);
    expect(versions).toHaveLength(0);
  });

  it("creates a pre_restore snapshot of current state first, then makes the restored version's content current — end-to-end 'state A, save, state B, restore -> A again' flow (PLAN.md §8's Phase 3 exit criterion)", async () => {
    const owner = await createTestUser("docstorage-restore-owner");
    const project = await createTestProject(owner.id);

    // State A, saved as a manual version.
    const editor = createMarkerEditor();
    await appendUpdate(project.id, editor.setMarker("state-A"), owner.id);
    const versionA = await createProjectVersion(project.id, { kind: "manual", label: "State A", createdBy: owner.id });

    // Change to state B (a later edit, not saved as a version).
    await appendUpdate(project.id, editor.setMarker("state-B"), owner.id);
    const { doc: beforeRestore } = await loadProjectDoc(project.id);
    expect(beforeRestore.getMap("meta").get("marker")).toBe("state-B");

    // Restore to state A.
    const result = await restoreProjectVersion(project.id, versionA.id, owner.id);
    expect(result).not.toBeNull();
    expect(result!.restoredVersionId).toBe(versionA.id);
    expect(result!.preRestoreVersion).not.toBeNull();
    expect(result!.preRestoreVersion!.kind).toBe("pre_restore");

    // The canvas (a fresh load) shows state A again.
    const { doc: afterRestore, appliedLogRows } = await loadProjectDoc(project.id);
    expect(afterRestore.getMap("meta").get("marker")).toBe("state-A");
    // The pre-restore log (state B's un-folded update) was discarded, not
    // left to re-merge on top of the restored snapshot.
    expect(appliedLogRows).toHaveLength(0);

    // A pre_restore snapshot of state B now exists in the version list.
    const versions = await listProjectVersions(project.id);
    expect(versions).toHaveLength(2);
    const preRestore = versions.find((v) => v.kind === "pre_restore");
    expect(preRestore).toBeDefined();
    expect(preRestore!.id).toBe(result!.preRestoreVersion!.id);

    const preRestoreBytes = await getProjectVersionBytes(project.id, preRestore!.id);
    const preRestoreDoc = new Y.Doc();
    Y.applyUpdate(preRestoreDoc, preRestoreBytes!);
    expect(preRestoreDoc.getMap("meta").get("marker")).toBe("state-B");
  });

  it("is a wholesale replace, not a merge — content present only in the post-version state does not survive the restore", async () => {
    const owner = await createTestUser("docstorage-restore-wholesale-owner");
    const project = await createTestProject(owner.id);

    // Version snapshot with one node.
    const nodesDoc1 = new Y.Doc();
    nodesDoc1.transact(() => {
      const node = new Y.Map<unknown>();
      node.set("id", "n_1");
      nodesDoc1.getMap("nodes").set("n_1", node);
    });
    await appendUpdate(project.id, Y.encodeStateAsUpdate(nodesDoc1), owner.id);
    const version = await createProjectVersion(project.id, { kind: "manual", createdBy: owner.id });

    // A second node added *after* the version was saved.
    const nodesDoc2 = new Y.Doc();
    nodesDoc2.transact(() => {
      const node = new Y.Map<unknown>();
      node.set("id", "n_2");
      nodesDoc2.getMap("nodes").set("n_2", node);
    });
    await appendUpdate(project.id, Y.encodeStateAsUpdate(nodesDoc2), owner.id);

    const { doc: beforeRestore } = await loadProjectDoc(project.id);
    expect(beforeRestore.getMap("nodes").size).toBe(2);

    await restoreProjectVersion(project.id, version.id, owner.id);

    // If this were a merge (Y.applyUpdate onto the live doc) rather than a
    // wholesale replace, n_2 would still be present — it isn't.
    const { doc: afterRestore } = await loadProjectDoc(project.id);
    expect(afterRestore.getMap("nodes").size).toBe(1);
    expect(afterRestore.getMap("nodes").has("n_1")).toBe(true);
    expect(afterRestore.getMap("nodes").has("n_2")).toBe(false);
  });

  it("restoring twice in a row (restore to A, then restore that same pre_restore snapshot back) round-trips correctly", async () => {
    const owner = await createTestUser("docstorage-restore-roundtrip-owner");
    const project = await createTestProject(owner.id);

    const editor = createMarkerEditor();
    await appendUpdate(project.id, editor.setMarker("state-A"), owner.id);
    const versionA = await createProjectVersion(project.id, { kind: "manual", createdBy: owner.id });

    await appendUpdate(project.id, editor.setMarker("state-B"), owner.id);

    const firstRestore = await restoreProjectVersion(project.id, versionA.id, owner.id);
    const { doc: afterFirstRestore } = await loadProjectDoc(project.id);
    expect(afterFirstRestore.getMap("meta").get("marker")).toBe("state-A");

    // Restore back to the pre_restore snapshot of state B taken by the first restore.
    await restoreProjectVersion(project.id, firstRestore!.preRestoreVersion!.id, owner.id);
    const { doc: afterSecondRestore } = await loadProjectDoc(project.id);
    expect(afterSecondRestore.getMap("meta").get("marker")).toBe("state-B");
  });

  it("skips the pre_restore safety snapshot when createPreRestoreVersion: false is passed", async () => {
    const owner = await createTestUser("docstorage-restore-nobackup-owner");
    const project = await createTestProject(owner.id);

    const editor = createMarkerEditor();
    await appendUpdate(project.id, editor.setMarker("state-A"), owner.id);
    const versionA = await createProjectVersion(project.id, { kind: "manual", createdBy: owner.id });

    await appendUpdate(project.id, editor.setMarker("state-B"), owner.id);

    const result = await restoreProjectVersion(project.id, versionA.id, owner.id, { createPreRestoreVersion: false });
    expect(result).not.toBeNull();
    expect(result!.preRestoreVersion).toBeNull();

    // The restore itself still happened...
    const { doc } = await loadProjectDoc(project.id);
    expect(doc.getMap("meta").get("marker")).toBe("state-A");

    // ...but state B was never snapshotted, so only versionA exists.
    const versions = await listProjectVersions(project.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.id).toBe(versionA.id);
  });
});

describe("deleteProjectVersion", () => {
  it("deletes a version and returns true", async () => {
    const owner = await createTestUser("docstorage-delete-owner");
    const project = await createTestProject(owner.id);
    const version = await createProjectVersion(project.id, { kind: "manual", label: "To delete", createdBy: owner.id });

    const deleted = await deleteProjectVersion(project.id, version.id);
    expect(deleted).toBe(true);

    const versions = await listProjectVersions(project.id);
    expect(versions).toHaveLength(0);
  });

  it("returns false for a nonexistent version id", async () => {
    const owner = await createTestUser("docstorage-delete-missing-owner");
    const project = await createTestProject(owner.id);

    const deleted = await deleteProjectVersion(project.id, crypto.randomUUID());
    expect(deleted).toBe(false);
  });

  it("does not delete a version belonging to a different project (scoped)", async () => {
    const owner = await createTestUser("docstorage-delete-crossproject-owner");
    const projectA = await createTestProject(owner.id);
    const projectB = await createTestProject(owner.id);
    const version = await createProjectVersion(projectA.id, { kind: "manual", createdBy: owner.id });

    const deleted = await deleteProjectVersion(projectB.id, version.id);
    expect(deleted).toBe(false);

    const versions = await listProjectVersions(projectA.id);
    expect(versions).toHaveLength(1);
  });

  it("deleting a version does not affect the project's live document state", async () => {
    const owner = await createTestUser("docstorage-delete-livestate-owner");
    const project = await createTestProject(owner.id);
    await appendUpdate(project.id, singleMarkerUpdate("still-here"), owner.id);
    const version = await createProjectVersion(project.id, { kind: "manual", createdBy: owner.id });

    await deleteProjectVersion(project.id, version.id);

    const { doc } = await loadProjectDoc(project.id);
    expect(doc.getMap("meta").get("marker")).toBe("still-here");
  });
});

describe("appendUpdate auto-versioning", () => {
  it("creates an 'auto' project_versions snapshot when a threshold-triggered compaction actually folds rows", async () => {
    const owner = await createTestUser("docstorage-autoversion-owner");
    const project = await createTestProject(owner.id);

    const THRESHOLD = 2;
    const editor = createMarkerEditor();
    for (let i = 0; i < 3; i++) {
      await appendUpdate(project.id, editor.setMarker(`m${i}`), owner.id, THRESHOLD);
    }

    const versions = await listProjectVersions(project.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.kind).toBe("auto");

    const bytes = await getProjectVersionBytes(project.id, versions[0]!.id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes!);
    expect(doc.getMap("meta").get("marker")).toBe("m2");
  });

  it("does not create an auto version when the append doesn't cross the compaction threshold", async () => {
    const owner = await createTestUser("docstorage-noautoversion-owner");
    const project = await createTestProject(owner.id);

    await appendUpdate(project.id, singleMarkerUpdate("below-threshold"), owner.id, 200);

    const versions = await listProjectVersions(project.id);
    expect(versions).toHaveLength(0);
  });
});
