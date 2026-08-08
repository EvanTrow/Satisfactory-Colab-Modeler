import {
  addContainer,
  addEdge,
  addNode,
  createDocument,
  createUndoManager,
  getContainer,
  getNode,
  listContainers,
  listEdges,
  listNodes,
  type SfmDocument,
} from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { deleteOutpost, moveNodeToContainer } from "./reparent";

function baseNode(containerId: string, title: string) {
  return {
    containerId,
    kind: "recipe",
    recipe: null,
    machine: null,
    x: 0,
    y: 0,
    title,
    color: "#4b5563",
    limit: null,
    limitMode: "machines" as const,
    clock: null,
    autoRound: false,
    shards: 0,
    purity: null,
    beltTier: null,
    storageMode: null,
    splurgerVariant: null,
  };
}

function makeFixture() {
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
  const outpost = addContainer(sfmDoc, {
    kind: "outpost",
    parentId: root.id,
    title: "Outpost",
    color: "#4b5563",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  return { sfmDoc, root, outpost };
}

describe("moveNodeToContainer", () => {
  it("updates only the node's containerId", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const node = addNode(sfmDoc, baseNode(root.id, "A"));
    moveNodeToContainer(sfmDoc, node.id, outpost.id);
    expect(getNode(sfmDoc, node.id)?.containerId).toBe(outpost.id);
  });
});

describe("deleteOutpost", () => {
  it("reparents child nodes and edges to the outpost's parent, then removes the container", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const a = addNode(sfmDoc, baseNode(outpost.id, "A"));
    const b = addNode(sfmDoc, baseNode(outpost.id, "B"));
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

    const result = deleteOutpost(sfmDoc, outpost.id);

    expect(result.reparentedNodeIds.sort()).toEqual([a.id, b.id].sort());
    expect(result.reparentedEdgeIds).toEqual([edge.id]);

    // Never destroyed — still present, now living directly in root.
    expect(getNode(sfmDoc, a.id)?.containerId).toBe(root.id);
    expect(getNode(sfmDoc, b.id)?.containerId).toBe(root.id);
    expect(listEdges(sfmDoc).find((e) => e.id === edge.id)?.containerId).toBe(root.id);

    // The outpost container itself is gone.
    expect(getContainer(sfmDoc, outpost.id)).toBeUndefined();
    expect(listNodes(sfmDoc)).toHaveLength(2);
  });

  it("reparents nested outposts (not just leaf nodes) up to the parent instead of orphaning them", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const nested = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: outpost.id,
      title: "Nested",
      color: "#4b5563",
      x: 0,
      y: 0,
      copiesLimit: null,
    });

    deleteOutpost(sfmDoc, outpost.id);

    expect(getContainer(sfmDoc, nested.id)?.parentId).toBe(root.id);
    expect(listContainers(sfmDoc).map((c) => c.id).sort()).toEqual([root.id, nested.id].sort());
  });

  it("is a single undo step for the whole reparent-and-delete operation", () => {
    const { sfmDoc, outpost } = makeFixture();
    const a = addNode(sfmDoc, baseNode(outpost.id, "A"));
    const b = addNode(sfmDoc, baseNode(outpost.id, "B"));
    addEdge(sfmDoc, {
      containerId: outpost.id,
      part: "Iron Ore",
      fromNode: a.id,
      fromPort: "out:Iron Ore",
      toNode: b.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    const undoManager = createUndoManager(sfmDoc);
    undoManager.stopCapturing();

    deleteOutpost(sfmDoc, outpost.id);
    expect(getContainer(sfmDoc, outpost.id)).toBeUndefined();

    undoManager.undo();

    // Everything restored in one undo call: the outpost container is back,
    // and both nodes + the edge are back inside it.
    expect(getContainer(sfmDoc, outpost.id)).toBeDefined();
    expect(getNode(sfmDoc, a.id)?.containerId).toBe(outpost.id);
    expect(getNode(sfmDoc, b.id)?.containerId).toBe(outpost.id);
    expect(listEdges(sfmDoc)[0]?.containerId).toBe(outpost.id);
  });

  it("throws for an unknown outpost id", () => {
    const { sfmDoc } = makeFixture();
    expect(() => deleteOutpost(sfmDoc, "c_missing")).toThrow();
  });

  it("throws when asked to delete the root container", () => {
    const { sfmDoc, root } = makeFixture();
    expect(() => deleteOutpost(sfmDoc, root.id)).toThrow();
  });
});
