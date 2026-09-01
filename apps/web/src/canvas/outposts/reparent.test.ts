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
  updateContainer,
} from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { ensureOutpostIoNodes, outpostInputNodeId, outpostOutputNodeId } from "./io";
import { deleteOutpost, deleteOutpostWithContents, moveNodeToContainer } from "./reparent";

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
    splitterVariant: null,
    mergerVariant: null,
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
  });
  const outpost = addContainer(sfmDoc, {
    kind: "outpost",
    parentId: root.id,
    title: "Outpost",
    color: "#4b5563",
    x: 0,
    y: 0,
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

  it("collapses the locked Inputs/Outputs nodes into a direct edge instead of reparenting them", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    ensureOutpostIoNodes(sfmDoc, outpost.id, "#4b5563");
    const inputId = outpostInputNodeId(outpost.id);
    const outputId = outpostOutputNodeId(outpost.id);
    const producer = addNode(sfmDoc, baseNode(root.id, "Producer"));
    const internal = addNode(sfmDoc, baseNode(outpost.id, "Internal"));
    const consumer = addNode(sfmDoc, baseNode(root.id, "Consumer"));

    // producer -> Inputs -> internal -> Outputs -> consumer
    addEdge(sfmDoc, {
      containerId: root.id,
      part: "Iron Ore",
      fromNode: producer.id,
      fromPort: "out:Iron Ore",
      toNode: inputId,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    addEdge(sfmDoc, {
      containerId: outpost.id,
      part: "Iron Ore",
      fromNode: inputId,
      fromPort: "out:Iron Ore",
      toNode: internal.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    addEdge(sfmDoc, {
      containerId: outpost.id,
      part: "Iron Plate",
      fromNode: internal.id,
      fromPort: "out:Iron Plate",
      toNode: outputId,
      toPort: "in:Iron Plate",
      style: null,
      labelPos: null,
    });
    addEdge(sfmDoc, {
      containerId: root.id,
      part: "Iron Plate",
      fromNode: outputId,
      fromPort: "out:Iron Plate",
      toNode: consumer.id,
      toPort: "in:Iron Plate",
      style: null,
      labelPos: null,
    });

    deleteOutpost(sfmDoc, outpost.id);

    // The locked pass-through nodes are gone entirely, not stranded in root.
    expect(getNode(sfmDoc, inputId)).toBeUndefined();
    expect(getNode(sfmDoc, outputId)).toBeUndefined();

    // Their pass-through edges collapsed into direct producer/consumer edges.
    const edges = listEdges(sfmDoc);
    expect(edges.some((e) => e.fromNode === producer.id && e.toNode === internal.id && e.part === "Iron Ore")).toBe(
      true,
    );
    expect(edges.some((e) => e.fromNode === internal.id && e.toNode === consumer.id && e.part === "Iron Plate")).toBe(
      true,
    );
    expect(edges).toHaveLength(2);
  });

  it("shifts reparented nodes to where the outpost's own boundary card sat, so they don't land on top of existing content", () => {
    const { sfmDoc, outpost } = makeFixture();
    // Reposition the outpost's own boundary card to a distinct spot in root
    // (`makeFixture` places it at (0,0), same as every node's default position
    // — not a useful case for checking the shift actually happened).
    updateContainer(sfmDoc, outpost.id, { x: 500, y: 300 });
    const a = addNode(sfmDoc, { ...baseNode(outpost.id, "A"), x: 10, y: 20 });
    const b = addNode(sfmDoc, { ...baseNode(outpost.id, "B"), x: 40, y: 20 });

    deleteOutpost(sfmDoc, outpost.id);

    // The pair's relative offset from each other is preserved (rigid-body
    // shift), and their new top-left corner lands exactly at the outpost's
    // former (500, 300) position rather than at their raw local (10, 20).
    expect(getNode(sfmDoc, a.id)).toMatchObject({ x: 500, y: 300 });
    expect(getNode(sfmDoc, b.id)).toMatchObject({ x: 530, y: 300 });
  });
});

describe("deleteOutpostWithContents", () => {
  it("removes the container, every node inside it (at any depth), and every edge touching one of those nodes", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const nested = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: outpost.id,
      title: "Nested",
      color: "#4b5563",
      x: 0,
      y: 0,
    });
    const a = addNode(sfmDoc, baseNode(outpost.id, "A"));
    const b = addNode(sfmDoc, baseNode(nested.id, "B"));
    const outsider = addNode(sfmDoc, baseNode(root.id, "Outsider"));
    const internalEdge = addEdge(sfmDoc, {
      containerId: outpost.id,
      part: "Iron Ore",
      fromNode: a.id,
      fromPort: "out:Iron Ore",
      toNode: b.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    // A boundary-crossing edge reaching OUT of the deleted subtree — must
    // also be deleted (dangling reference otherwise), even though it's
    // drawn from `root`'s own view (its `containerId` is `root.id`, NOT
    // inside the deleted subtree — this is exactly the case the
    // `containerId`-isn't-authoritative note in the implementation guards
    // against).
    const crossingEdge = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Copper Ore",
      fromNode: b.id,
      fromPort: "out:Copper Ore",
      toNode: outsider.id,
      toPort: "in:Copper Ore",
      style: null,
      labelPos: null,
    });

    deleteOutpostWithContents(sfmDoc, outpost.id);

    expect(getContainer(sfmDoc, outpost.id)).toBeUndefined();
    expect(getContainer(sfmDoc, nested.id)).toBeUndefined();
    expect(getNode(sfmDoc, a.id)).toBeUndefined();
    expect(getNode(sfmDoc, b.id)).toBeUndefined();
    expect(listEdges(sfmDoc).find((e) => e.id === internalEdge.id)).toBeUndefined();
    expect(listEdges(sfmDoc).find((e) => e.id === crossingEdge.id)).toBeUndefined();

    // Untouched: the sibling node outside the deleted subtree.
    expect(getNode(sfmDoc, outsider.id)).toBeDefined();
    expect(getContainer(sfmDoc, root.id)).toBeDefined();
  });

  it("throws for an unknown outpost id, and for the root container", () => {
    const { sfmDoc, root } = makeFixture();
    expect(() => deleteOutpostWithContents(sfmDoc, "c_missing")).toThrow();
    expect(() => deleteOutpostWithContents(sfmDoc, root.id)).toThrow();
  });
});
