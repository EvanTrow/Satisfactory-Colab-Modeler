// Job 012's acceptance-criteria-mandated undo/redo tests: "undo after a
// multi-node delete restores everything in one step; redo re-applies it."
// This exercises `clipboard.ts`'s `deleteSelection`/`pasteClipboard`
// together with `@scm/ydoc`'s real `createUndoManager` (Job 007) — not a
// mock — to prove the transaction-grouping this job's code relies on
// (single `doc.transact()` per user action → single `Y.UndoManager` stack
// entry) actually holds end to end.
import {
  type NewEdgeInput,
  type NewNodeInput,
  addContainer,
  addEdge,
  addNode,
  createDocument,
  createUndoManager,
  listEdges,
  listNodes,
  moveNode,
} from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { buildClipboard, deleteSelection, pasteClipboard } from "./clipboard";

function baseNode(containerId: string, overrides: Partial<NewNodeInput> = {}): NewNodeInput {
  return {
    containerId,
    kind: "recipe",
    recipe: "Recipe_IronPlate_C",
    machine: "Constructor",
    x: 0,
    y: 0,
    title: "",
    color: "#ffffff",
    limit: null,
    limitMode: "machines",
    clock: null,
    autoRound: false,
    shards: 0,
    purity: null,
    beltTier: null,
    storageMode: null,
    splurgerVariant: null,
    ...overrides,
  };
}

function baseEdge(containerId: string, overrides: Partial<NewEdgeInput> = {}): NewEdgeInput {
  return {
    containerId,
    part: "Iron Ingot",
    fromNode: "",
    fromPort: "out:Iron Ingot",
    toNode: "",
    toPort: "in:Iron Ingot",
    style: null,
    labelPos: null,
    ...overrides,
  };
}

function setUp() {
  const sfmDoc = createDocument();
  const root = addContainer(sfmDoc, {
    kind: "root",
    parentId: null,
    title: "Root",
    color: "#000000",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  return { sfmDoc, root };
}

describe("deleteSelection + Y.UndoManager", () => {
  it("undoing a multi-node delete restores every node and edge in one step; redo re-deletes them in one step", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0, title: "A" }));
    const b = addNode(sfmDoc, baseNode(root.id, { x: 100, y: 0, title: "B" }));
    const c = addNode(sfmDoc, baseNode(root.id, { x: 200, y: 0, title: "C" }));
    addEdge(sfmDoc, baseEdge(root.id, { fromNode: a.id, toNode: b.id }));
    addEdge(sfmDoc, baseEdge(root.id, { fromNode: b.id, toNode: c.id, part: "Iron Ore" }));

    const undoManager = createUndoManager(sfmDoc);
    // A prior, unrelated edit that must stay on its own stack entry and be
    // unaffected by undoing the delete below.
    moveNode(sfmDoc, a.id, 5, 5);
    undoManager.stopCapturing();

    expect(listNodes(sfmDoc)).toHaveLength(3);
    expect(listEdges(sfmDoc)).toHaveLength(2);

    deleteSelection(sfmDoc, [a.id, b.id, c.id], []);
    expect(listNodes(sfmDoc)).toHaveLength(0);
    expect(listEdges(sfmDoc)).toHaveLength(0);
    expect(undoManager.undoStack).toHaveLength(2); // the earlier move + this one delete

    undoManager.undo();
    expect(listNodes(sfmDoc)).toHaveLength(3);
    expect(listEdges(sfmDoc)).toHaveLength(2);
    expect(listNodes(sfmDoc).map((n) => n.title).sort()).toEqual(["A", "B", "C"]);
    // The earlier, separate move is untouched by undoing the delete.
    expect(listNodes(sfmDoc).find((n) => n.id === a.id)?.x).toBe(5);

    undoManager.redo();
    expect(listNodes(sfmDoc)).toHaveLength(0);
    expect(listEdges(sfmDoc)).toHaveLength(0);
  });
});

describe("pasteClipboard + Y.UndoManager", () => {
  it("undoing a paste of two connected nodes removes both the nodes and their internal edge in one step", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0 }));
    const b = addNode(sfmDoc, baseNode(root.id, { x: 100, y: 0 }));
    addEdge(sfmDoc, baseEdge(root.id, { fromNode: a.id, toNode: b.id }));
    const clipboard = buildClipboard(sfmDoc, [a.id, b.id])!;

    const undoManager = createUndoManager(sfmDoc);
    pasteClipboard(sfmDoc, root.id, clipboard, { dx: 40, dy: 40 });

    expect(listNodes(sfmDoc)).toHaveLength(4);
    expect(listEdges(sfmDoc)).toHaveLength(2);
    expect(undoManager.undoStack).toHaveLength(1);

    undoManager.undo();
    expect(listNodes(sfmDoc)).toHaveLength(2);
    expect(listEdges(sfmDoc)).toHaveLength(1);

    undoManager.redo();
    expect(listNodes(sfmDoc)).toHaveLength(4);
    expect(listEdges(sfmDoc)).toHaveLength(2);
  });
});
