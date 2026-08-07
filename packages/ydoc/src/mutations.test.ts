import { describe, expect, it } from "vitest";
import { createDocument, getNode, getSettings, listEdges, listNodes, snapshotDocument } from "./document";
import { computeEdgeId } from "./edgeId";
import {
  addContainer,
  addEdge,
  addNode,
  addWaypoint,
  moveNode,
  removeContainer,
  removeEdge,
  removeNode,
  removeWaypoint,
  reparentEdge,
  setPriorityOrder,
  updateNode,
  updateSettings,
} from "./mutations";
import type { NewNodeInput } from "./mutations";
import type { SfmDocument } from "./document";

function baseNode(containerId: string): NewNodeInput {
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

describe("settings mutations", () => {
  it("updateSettings patches top-level fields and leaves the rest untouched", () => {
    const { sfmDoc } = setUp();
    expect(getSettings(sfmDoc).snapMachines).toBe(false);

    const updated = updateSettings(sfmDoc, { snapMachines: true });
    expect(updated.snapMachines).toBe(true);
    // Untouched fields survive the patch (Job 007's other defaults).
    expect(updated.snapWaypoints).toBe(false);
    expect(getSettings(sfmDoc).snapMachines).toBe(true);
  });

  it("updateSettings replaces a nested Point field as a whole object", () => {
    const { sfmDoc } = setUp();
    const updated = updateSettings(sfmDoc, { gridMachine: { x: 25, y: 25 } });
    expect(updated.gridMachine).toEqual({ x: 25, y: 25 });
  });
});

describe("container mutations", () => {
  it("addContainer/removeContainer round-trip", () => {
    const { sfmDoc, root } = setUp();
    expect(sfmDoc.containers.size).toBe(1);

    removeContainer(sfmDoc, root.id);
    expect(sfmDoc.containers.size).toBe(0);
  });
});

describe("node mutations", () => {
  it("addNode/updateNode/removeNode", () => {
    const { sfmDoc, root } = setUp();
    const node = addNode(sfmDoc, baseNode(root.id));
    expect(getNode(sfmDoc, node.id)).toEqual(node);

    const updated = updateNode(sfmDoc, node.id, { title: "Iron Plates", shards: 2 });
    expect(updated.title).toBe("Iron Plates");
    expect(updated.shards).toBe(2);

    const moved = moveNode(sfmDoc, node.id, 42, 99);
    expect(moved.x).toBe(42);
    expect(moved.y).toBe(99);

    removeNode(sfmDoc, node.id);
    expect(getNode(sfmDoc, node.id)).toBeUndefined();
  });

  it("setPriorityOrder replaces the priorityOrder array", () => {
    const { sfmDoc, root } = setUp();
    const node = addNode(sfmDoc, { ...baseNode(root.id), priorityOrder: ["p1"] });
    expect(getNode(sfmDoc, node.id)?.priorityOrder).toEqual(["p1"]);

    const updated = setPriorityOrder(sfmDoc, node.id, ["p2", "p3"]);
    expect(updated.priorityOrder).toEqual(["p2", "p3"]);

    const cleared = setPriorityOrder(sfmDoc, node.id, []);
    expect(cleared.priorityOrder).toEqual([]);
  });
});

describe("edge mutations", () => {
  function twoNodes(sfmDoc: SfmDocument, containerId: string) {
    const a = addNode(sfmDoc, baseNode(containerId));
    const b = addNode(sfmDoc, baseNode(containerId));
    return { a, b };
  }

  it("deterministic edgeId: two independent addEdge calls with the same 4-tuple merge into one edge", () => {
    const { sfmDoc, root } = setUp();
    const { a, b } = twoNodes(sfmDoc, root.id);

    const first = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: null,
      labelPos: null,
    });

    // Simulate a second, independent "concurrent" call for the exact same
    // connection (e.g. two users dragging the same wire at once).
    const second = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: null,
      labelPos: null,
    });

    expect(first.id).toBe(second.id);
    expect(first.id).toBe(computeEdgeId(a.id, "out-0", b.id, "in-0"));
    expect(sfmDoc.edges.size).toBe(1);
    expect(listEdges(sfmDoc)).toHaveLength(1);
  });

  it("addEdge is idempotent and does not clobber an existing edge's fields", () => {
    const { sfmDoc, root } = setUp();
    const { a, b } = twoNodes(sfmDoc, root.id);

    const first = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: "custom-style",
      labelPos: 0.5,
    });

    const second = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: "different-style",
      labelPos: 0.9,
    });

    expect(second).toEqual(first);
    expect(second.style).toBe("custom-style");
  });

  it("removeEdge deletes the entry", () => {
    const { sfmDoc, root } = setUp();
    const { a, b } = twoNodes(sfmDoc, root.id);
    const edge = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: null,
      labelPos: null,
    });
    removeEdge(sfmDoc, edge.id);
    expect(sfmDoc.edges.size).toBe(0);
  });

  it("reparentEdge updates containerId without touching endpoints/id", () => {
    const { sfmDoc, root } = setUp();
    const { a, b } = twoNodes(sfmDoc, root.id);
    const edge = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: null,
      labelPos: null,
    });

    const reparented = reparentEdge(sfmDoc, edge.id, "c_other");
    expect(reparented.containerId).toBe("c_other");
    expect(reparented.id).toBe(edge.id);
    expect(reparented.fromNode).toBe(a.id);
    expect(reparented.toNode).toBe(b.id);
  });

  it("reparentEdge throws for an unknown edge id", () => {
    const { sfmDoc } = setUp();
    expect(() => reparentEdge(sfmDoc, "e_missing", "c_other")).toThrow();
  });

  it("addWaypoint/removeWaypoint manage the edge's waypoint list", () => {
    const { sfmDoc, root } = setUp();
    const { a, b } = twoNodes(sfmDoc, root.id);
    const edge = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: null,
      labelPos: null,
    });

    const withWaypoint = addWaypoint(sfmDoc, edge.id, { x: 10, y: 20 });
    expect(withWaypoint.waypoints).toEqual([{ x: 10, y: 20 }]);

    const withSecond = addWaypoint(sfmDoc, edge.id, { x: 30, y: 40 }, 0);
    expect(withSecond.waypoints).toEqual([
      { x: 30, y: 40 },
      { x: 10, y: 20 },
    ]);

    const afterRemove = removeWaypoint(sfmDoc, edge.id, 0);
    expect(afterRemove.waypoints).toEqual([{ x: 10, y: 20 }]);
  });
});

describe("transaction batching", () => {
  it("each mutation helper produces exactly one Yjs update event", () => {
    const { sfmDoc, root } = setUp();
    let updateCount = 0;
    sfmDoc.doc.on("update", () => {
      updateCount += 1;
    });

    addNode(sfmDoc, baseNode(root.id));
    expect(updateCount).toBe(1);

    const { a, b } = (() => {
      const a2 = addNode(sfmDoc, baseNode(root.id));
      const b2 = addNode(sfmDoc, baseNode(root.id));
      return { a: a2, b: b2 };
    })();
    updateCount = 0;

    addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: null,
      labelPos: null,
    });
    expect(updateCount).toBe(1);
  });
});

describe("snapshotDocument", () => {
  it("reflects containers/nodes/edges after mutation", () => {
    const { sfmDoc, root } = setUp();
    const { a, b } = (() => {
      const a2 = addNode(sfmDoc, baseNode(root.id));
      const b2 = addNode(sfmDoc, baseNode(root.id));
      return { a: a2, b: b2 };
    })();
    addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: null,
      labelPos: null,
    });

    const snapshot = snapshotDocument(sfmDoc);
    expect(snapshot.containers).toHaveLength(1);
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.edges).toHaveLength(1);
    expect(listNodes(sfmDoc)).toHaveLength(2);
  });
});
