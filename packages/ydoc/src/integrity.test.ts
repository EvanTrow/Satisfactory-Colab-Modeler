import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";

import { createDocument, getContainer, getNode, listEdges, listNodes } from "./document";
import { isNoopRepair, repairDocument, runIntegrityReducer } from "./integrity";
import { addContainer, addEdge, addNode } from "./mutations";
import { INTEGRITY_ORIGIN, createUndoManager } from "./undo";
import type { SfmDocument } from "./document";

function baseNode(containerId: string, overrides: Partial<Parameters<typeof addNode>[1]> = {}) {
  return {
    containerId,
    kind: "recipe",
    recipe: null,
    machine: null,
    x: 0,
    y: 0,
    title: "",
    color: "#4b5563",
    limit: null,
    limitMode: "machines" as const,
    clock: null,
    autoRound: false,
    shards: 0,
    purity: null,
    beltTier: null,
    storageMode: null,
    ...overrides,
  };
}

function fixture() {
  const sfmDoc: SfmDocument = createDocument();
  const root = addContainer(sfmDoc, {
    kind: "root",
    parentId: null,
    title: "Root",
    color: "#4b5563",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  return { sfmDoc, root };
}

describe("repairDocument", () => {
  it("is a no-op on an already-clean document", () => {
    const { sfmDoc, root } = fixture();
    addNode(sfmDoc, baseNode(root.id, { title: "A" }));
    const summary = repairDocument(sfmDoc, defaultGameData);
    expect(isNoopRepair(summary)).toBe(true);
  });

  it("rule 1: deletes edges whose fromNode or toNode no longer exists", () => {
    const { sfmDoc, root } = fixture();
    const a = addNode(sfmDoc, baseNode(root.id, { title: "A" }));
    const b = addNode(sfmDoc, baseNode(root.id, { title: "B" }));
    const edge = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Iron Ore",
      fromNode: a.id,
      fromPort: "out:Iron Ore",
      toNode: b.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });

    // Simulate a concurrent delete-vs-connect race: node `b` was removed by
    // another client (bypassing removeEdge's own cascade, exactly like the
    // raw Y.Map delete a concurrent CRDT merge would produce).
    sfmDoc.nodes.delete(b.id);

    const summary = repairDocument(sfmDoc, defaultGameData);

    expect(summary.deletedDanglingEdgeIds).toEqual([edge.id]);
    expect(listEdges(sfmDoc)).toHaveLength(0);
    expect(getNode(sfmDoc, a.id)).toBeDefined();
  });

  it("rule 2: reparents an orphaned node (dangling containerId) to root instead of deleting it", () => {
    const { sfmDoc, root } = fixture();
    const outpost = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root.id,
      title: "Outpost",
      color: "#4b5563",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    const node = addNode(sfmDoc, baseNode(outpost.id, { title: "A" }));

    // Concurrent-delete-of-container race: the container is gone (raw
    // delete, not `removeContainer` + reparent — the outpost's own local
    // reparent-on-delete flow is Job 013's `deleteOutpost`; this is testing
    // the *general* repair for the same dangling reference from any cause).
    sfmDoc.containers.delete(outpost.id);

    const summary = repairDocument(sfmDoc, defaultGameData);

    expect(summary.reparentedNodeIds).toEqual([node.id]);
    expect(getNode(sfmDoc, node.id)).toBeDefined();
    expect(getNode(sfmDoc, node.id)?.containerId).toBe(root.id);
  });

  it("rule 2: reparents an orphaned nested container (dangling parentId) to root", () => {
    const { sfmDoc, root } = fixture();
    const outpost = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root.id,
      title: "Outpost",
      color: "#4b5563",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    const nested = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: outpost.id,
      title: "Nested",
      color: "#4b5563",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    sfmDoc.containers.delete(outpost.id);

    const summary = repairDocument(sfmDoc, defaultGameData);

    expect(summary.reparentedContainerIds).toEqual([nested.id]);
    expect(getContainer(sfmDoc, nested.id)?.parentId).toBe(root.id);
  });

  it("rule 2: reparents an orphaned edge's containerId to root without deleting the edge", () => {
    const { sfmDoc, root } = fixture();
    const outpost = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root.id,
      title: "Outpost",
      color: "#4b5563",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    const a = addNode(sfmDoc, baseNode(outpost.id, { title: "A" }));
    const b = addNode(sfmDoc, baseNode(outpost.id, { title: "B" }));
    const edge = addEdge(sfmDoc, {
      containerId: outpost.id,
      part: "Iron Ore",
      fromNode: a.id,
      fromPort: "out:Iron Ore",
      toNode: b.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    sfmDoc.containers.delete(outpost.id);

    const summary = repairDocument(sfmDoc, defaultGameData);

    expect(summary.reparentedEdgeContainerIds).toEqual([edge.id]);
    expect(listEdges(sfmDoc).find((e) => e.id === edge.id)?.containerId).toBe(root.id);
  });

  it("rule 3: clamps shards to the node's resolved machine's MaxProductionShards", () => {
    const { sfmDoc, root } = fixture();
    const node = addNode(
      sfmDoc,
      baseNode(root.id, {
        title: "Manufacturer",
        recipe: "Plastic Smart Plating",
        machine: "Manufacturer",
        shards: 10, // Manufacturer's MaxProductionShards is 4
      }),
    );

    const summary = repairDocument(sfmDoc, defaultGameData);

    expect(summary.clampedShardNodeIds).toEqual([node.id]);
    expect(getNode(sfmDoc, node.id)?.shards).toBe(4);
  });

  it("rule 3: drops an edge wired to a port the node's current recipe doesn't have", () => {
    const { sfmDoc, root } = fixture();
    const node = addNode(
      sfmDoc,
      baseNode(root.id, {
        title: "Manufacturer",
        recipe: "Plastic Smart Plating",
        machine: "Manufacturer",
      }),
    );
    const other = addNode(sfmDoc, baseNode(root.id, { title: "Other" }));

    // Valid: "Plastic Smart Plating" really does output "Smart Plating".
    const validEdge = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Smart Plating",
      fromNode: node.id,
      fromPort: "out:Smart Plating",
      toNode: other.id,
      toPort: "in:Smart Plating",
      style: null,
      labelPos: null,
    });
    // Invalid: this recipe has no such port — simulates "someone changed
    // the recipe while someone else was wired to the old one's port."
    const invalidEdge = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Screw",
      fromNode: node.id,
      fromPort: "out:Screw",
      toNode: other.id,
      toPort: "in:Screw",
      style: null,
      labelPos: null,
    });

    const summary = repairDocument(sfmDoc, defaultGameData);

    expect(summary.deletedInvalidPortEdgeIds).toEqual([invalidEdge.id]);
    expect(listEdges(sfmDoc).map((e) => e.id).sort()).toEqual([validEdge.id].sort());
  });

  it("leaves a node with an unresolvable recipe/machine alone (no game-data-version crash)", () => {
    const { sfmDoc, root } = fixture();
    const node = addNode(
      sfmDoc,
      baseNode(root.id, { title: "Stale", recipe: "Some Removed Recipe", machine: "Some Removed Machine", shards: 99 }),
    );

    expect(() => repairDocument(sfmDoc, defaultGameData)).not.toThrow();
    // Shards untouched — there's no machine to clamp against.
    expect(getNode(sfmDoc, node.id)?.shards).toBe(99);
  });

  it("rule 4: deduplicates two distinct edge entries representing the same connection, keeping the smaller id", () => {
    const { sfmDoc, root } = fixture();
    const a = addNode(sfmDoc, baseNode(root.id, { title: "A" }));
    const b = addNode(sfmDoc, baseNode(root.id, { title: "B" }));

    // Simulate corruption: two different top-level Y.Map keys both
    // describing the identical (fromNode, fromPort, toNode, toPort) tuple —
    // something Job 007's deterministic edgeId should make structurally
    // impossible via the normal addEdge path, but a non-conforming
    // client/bug could still write directly. Built by cloning a real edge's
    // `Y.Map` under a second key (keeps this test robust to Yjs internals
    // rather than hand-constructing one from scratch).
    const first = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Iron Ore",
      fromNode: a.id,
      fromPort: "out:Iron Ore",
      toNode: b.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    const duplicateId = `${first.id}_dup`;
    sfmDoc.doc.transact(() => {
      const original = sfmDoc.edges.get(first.id)!;
      const cloneMap = original.clone();
      cloneMap.set("id", duplicateId);
      sfmDoc.edges.set(duplicateId, cloneMap);
    });

    expect(listEdges(sfmDoc)).toHaveLength(2);

    const summary = repairDocument(sfmDoc, defaultGameData);

    const survivingId = first.id < duplicateId ? first.id : duplicateId;
    const removedId = first.id < duplicateId ? duplicateId : first.id;
    expect(summary.deletedDuplicateEdgeIds).toEqual([removedId]);
    expect(listEdges(sfmDoc).map((e) => e.id)).toEqual([survivingId]);
  });

  it("rule 5: normalizes a non-default Miner node back to Mk.1 x Normal, leaving its limit untouched", () => {
    const { sfmDoc, root } = fixture();
    const node = addNode(
      sfmDoc,
      baseNode(root.id, {
        title: "Iron Ore",
        recipe: "Iron Ore",
        machine: "Miner Mk.3",
        purity: "pure",
        limitMode: "ppm",
        limit: "480",
      }),
    );

    const summary = repairDocument(sfmDoc, defaultGameData);

    expect(summary.normalizedMinerNodeIds).toEqual([node.id]);
    const repaired = getNode(sfmDoc, node.id);
    expect(repaired?.machine).toBe("Miner Mk.1");
    expect(repaired?.purity).toBe("normal");
    // The user's own typed ppm target is a deliberate value, not a
    // variant-derived default — normalizing the variant must not touch it.
    expect(repaired?.limit).toBe("480");
  });

  it("rule 5: leaves an already-default Miner node alone", () => {
    const { sfmDoc, root } = fixture();
    addNode(
      sfmDoc,
      baseNode(root.id, {
        title: "Iron Ore",
        recipe: "Iron Ore",
        machine: "Miner Mk.1",
        purity: "normal",
        limitMode: "ppm",
      }),
    );

    const summary = repairDocument(sfmDoc, defaultGameData);

    expect(summary.normalizedMinerNodeIds).toEqual([]);
  });
});

describe("runIntegrityReducer", () => {
  it("runs under the reserved integrity origin and never lands on the undo stack", () => {
    const { sfmDoc, root } = fixture();
    const undoManager = createUndoManager(sfmDoc);
    const a = addNode(sfmDoc, baseNode(root.id, { title: "A" }));
    const b = addNode(sfmDoc, baseNode(root.id, { title: "B" }));
    addEdge(sfmDoc, {
      containerId: root.id,
      part: "Iron Ore",
      fromNode: a.id,
      fromPort: "out:Iron Ore",
      toNode: b.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    sfmDoc.nodes.delete(b.id);
    undoManager.stopCapturing();

    const undoStackBefore = undoManager.undoStack.length;
    let capturedOrigin: unknown;
    sfmDoc.doc.on("afterTransaction", (tr) => {
      capturedOrigin = tr.origin;
    });

    const summary = runIntegrityReducer(sfmDoc, defaultGameData);

    expect(summary.deletedDanglingEdgeIds).toHaveLength(1);
    expect(capturedOrigin).toBe(INTEGRITY_ORIGIN);
    expect(undoManager.undoStack.length).toBe(undoStackBefore);
  });

  it("is idempotent: running it twice in a row produces a no-op the second time", () => {
    const { sfmDoc, root } = fixture();
    const a = addNode(sfmDoc, baseNode(root.id, { title: "A" }));
    const b = addNode(sfmDoc, baseNode(root.id, { title: "B" }));
    addEdge(sfmDoc, {
      containerId: root.id,
      part: "Iron Ore",
      fromNode: a.id,
      fromPort: "out:Iron Ore",
      toNode: b.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    sfmDoc.nodes.delete(b.id);

    runIntegrityReducer(sfmDoc, defaultGameData);
    const second = runIntegrityReducer(sfmDoc, defaultGameData);

    expect(isNoopRepair(second)).toBe(true);
  });

  it("has nothing to reparent into (no root) without throwing, still runs the root-independent rules", () => {
    const sfmDoc: SfmDocument = createDocument();
    // Deliberately no root container.
    const a = addNode(sfmDoc, baseNode("c_missing", { title: "A" }));
    const b = addNode(sfmDoc, baseNode("c_missing", { title: "B" }));
    addEdge(sfmDoc, {
      containerId: "c_missing",
      part: "Iron Ore",
      fromNode: a.id,
      fromPort: "out:Iron Ore",
      toNode: b.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    sfmDoc.nodes.delete(b.id);

    expect(() => runIntegrityReducer(sfmDoc, defaultGameData)).not.toThrow();
    expect(listNodes(sfmDoc)).toHaveLength(1);
    expect(listEdges(sfmDoc)).toHaveLength(0);
  });
});
