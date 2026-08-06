import { describe, expect, it } from "vitest";
import { createDocument, getNode } from "./document";
import { addContainer, addNode, updateNode } from "./mutations";
import { INTEGRITY_ORIGIN, createUndoManager, runAsIntegrity } from "./undo";

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

describe("createUndoManager", () => {
  it("undo/redo restores prior document state for tracked (default-origin) changes", () => {
    const { sfmDoc, root } = setUp();
    const undoManager = createUndoManager(sfmDoc);

    const node = addNode(sfmDoc, {
      containerId: root.id,
      kind: "recipe",
      recipe: "Recipe_IronPlate_C",
      machine: "Constructor",
      x: 0,
      y: 0,
      title: "Original title",
      color: "#ffffff",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
    });
    undoManager.stopCapturing();

    updateNode(sfmDoc, node.id, { title: "Renamed" });
    expect(getNode(sfmDoc, node.id)?.title).toBe("Renamed");

    // Undo the rename.
    undoManager.undo();
    expect(getNode(sfmDoc, node.id)?.title).toBe("Original title");

    // Undo the node creation itself.
    undoManager.undo();
    expect(getNode(sfmDoc, node.id)).toBeUndefined();

    // Redo brings the node back, then reapplies the rename.
    undoManager.redo();
    expect(getNode(sfmDoc, node.id)?.title).toBe("Original title");
    undoManager.redo();
    expect(getNode(sfmDoc, node.id)?.title).toBe("Renamed");
  });

  it("never tracks changes made under origin: 'integrity'", () => {
    const { sfmDoc, root } = setUp();
    const undoManager = createUndoManager(sfmDoc);

    const node = addNode(sfmDoc, {
      containerId: root.id,
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
    });
    undoManager.stopCapturing();

    expect(undoManager.undoStack).toHaveLength(1);

    // Simulate the future integrity reducer (Job 022) repairing the doc.
    runAsIntegrity(sfmDoc, () => {
      updateNode(sfmDoc, node.id, { shards: 5 }, INTEGRITY_ORIGIN);
    });

    // The mutation was applied to the document...
    expect(getNode(sfmDoc, node.id)?.shards).toBe(5);
    // ...but it must not have created a new undo stack entry.
    expect(undoManager.undoStack).toHaveLength(1);

    // The only thing left to undo is the original node creation, not the
    // integrity-tagged shard change.
    undoManager.undo();
    expect(getNode(sfmDoc, node.id)).toBeUndefined();
    expect(undoManager.undoStack).toHaveLength(0);
  });

  it("even a caller-supplied trackedOrigins set can't reintroduce the integrity origin", () => {
    const { sfmDoc, root } = setUp();
    const undoManager = createUndoManager(sfmDoc, {
      trackedOrigins: new Set<unknown>([null, INTEGRITY_ORIGIN, "some-user-id"]),
    });

    const node = addNode(sfmDoc, {
      containerId: root.id,
      kind: "recipe",
      recipe: null,
      machine: null,
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
    });
    undoManager.stopCapturing();
    expect(undoManager.undoStack).toHaveLength(1);

    runAsIntegrity(sfmDoc, () => {
      updateNode(sfmDoc, node.id, { shards: 9 }, INTEGRITY_ORIGIN);
    });

    expect(undoManager.undoStack).toHaveLength(1);
  });
});
