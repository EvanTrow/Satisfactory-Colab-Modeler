// Unit tests for `clipboard.ts` against a real `@scm/ydoc` `createDocument()`
// fixture — same pattern `edges/connectionLogic.test.ts` established in Job
// 011, and the acceptance-criteria-mandated tests for this job: "paste
// produces new IDs with correct relative positions and correctly-scoped
// internal edges."
import {
  type NewEdgeInput,
  type NewNodeInput,
  type SfmDocument,
  addContainer,
  addEdge,
  addNode,
  createDocument,
  listEdges,
  listNodes,
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

describe("buildClipboard", () => {
  it("returns null when no ids are selected", () => {
    const { sfmDoc } = setUp();
    expect(buildClipboard(sfmDoc, [])).toBeNull();
  });

  it("returns null when the selected ids no longer exist in the doc", () => {
    const { sfmDoc } = setUp();
    expect(buildClipboard(sfmDoc, ["n_nope"])).toBeNull();
  });

  it("includes only edges whose both endpoints are in the selection — never a duplicate/dangling edge to a non-copied node", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0 }));
    const b = addNode(sfmDoc, baseNode(root.id, { x: 100, y: 0 }));
    const outside = addNode(sfmDoc, baseNode(root.id, { x: 200, y: 0 }));
    const internal = addEdge(sfmDoc, baseEdge(root.id, { fromNode: a.id, toNode: b.id }));
    addEdge(sfmDoc, baseEdge(root.id, { fromNode: b.id, toNode: outside.id, part: "Iron Ore" }));

    const clipboard = buildClipboard(sfmDoc, [a.id, b.id]);
    expect(clipboard).not.toBeNull();
    expect(clipboard!.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(clipboard!.edges.map((e) => e.id)).toEqual([internal.id]);
  });
});

describe("pasteClipboard", () => {
  it("regenerates node ids and preserves relative positions under the paste offset", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0 }));
    const b = addNode(sfmDoc, baseNode(root.id, { x: 100, y: 50 }));
    const clipboard = buildClipboard(sfmDoc, [a.id, b.id])!;

    const result = pasteClipboard(sfmDoc, root.id, clipboard, { dx: 40, dy: 20 });

    expect(result.nodeIds).toHaveLength(2);
    // Fresh ids — neither pasted node reuses an original id.
    expect(result.nodeIds).not.toContain(a.id);
    expect(result.nodeIds).not.toContain(b.id);

    const pastedNodes = result.nodeIds.map((id) => listNodes(sfmDoc).find((n) => n.id === id)!);
    const pastedA = pastedNodes.find((n) => n.x === 40 && n.y === 20)!;
    const pastedB = pastedNodes.find((n) => n.x === 140 && n.y === 70)!;
    expect(pastedA).toBeDefined();
    expect(pastedB).toBeDefined();
    // Relative offset between the two pasted nodes matches the originals (100, 50).
    expect(pastedB.x - pastedA.x).toBe(100);
    expect(pastedB.y - pastedA.y).toBe(50);

    // Originals are untouched.
    expect(listNodes(sfmDoc)).toHaveLength(4);
  });

  it("re-derives a fresh, correctly-scoped edge id for an edge between two copied nodes, and offsets its waypoints along with the nodes", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0 }));
    const b = addNode(sfmDoc, baseNode(root.id, { x: 100, y: 0 }));
    const edge = addEdge(
      sfmDoc,
      baseEdge(root.id, { fromNode: a.id, toNode: b.id, waypoints: [{ x: 50, y: 10 }] }),
    );
    const clipboard = buildClipboard(sfmDoc, [a.id, b.id])!;

    const result = pasteClipboard(sfmDoc, root.id, clipboard, { dx: 40, dy: 20 });

    expect(result.edgeIds).toHaveLength(1);
    const [newEdgeId] = result.edgeIds;
    expect(newEdgeId).not.toBe(edge.id);

    const pastedEdge = listEdges(sfmDoc).find((e) => e.id === newEdgeId)!;
    expect(pastedEdge).toBeDefined();
    expect(result.nodeIds).toContain(pastedEdge.fromNode);
    expect(result.nodeIds).toContain(pastedEdge.toNode);
    // Waypoint (an absolute canvas coordinate per Job 011) moved by the same offset as its endpoints.
    expect(pastedEdge.waypoints).toEqual([{ x: 90, y: 30 }]);

    // Original edge is untouched.
    expect(listEdges(sfmDoc)).toHaveLength(2);
  });

  it("does not paste an edge to a node outside the copied set even if it was in the clipboard's node list some other way", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0 }));
    const b = addNode(sfmDoc, baseNode(root.id, { x: 100, y: 0 }));
    // Only `a` is "copied" — `edges` deliberately omitted from the payload
    // even though a same-shaped edge exists in the doc, exercising that
    // `pasteClipboard` trusts the payload's own `edges` list (already
    // filtered by `buildClipboard`) rather than re-deriving from the doc.
    addEdge(sfmDoc, baseEdge(root.id, { fromNode: a.id, toNode: b.id }));

    const clipboard = buildClipboard(sfmDoc, [a.id])!;
    expect(clipboard.edges).toHaveLength(0);

    const result = pasteClipboard(sfmDoc, root.id, clipboard, { dx: 10, dy: 10 });
    expect(result.nodeIds).toHaveLength(1);
    expect(result.edgeIds).toHaveLength(0);
    expect(listEdges(sfmDoc)).toHaveLength(1); // only the original
  });

  it("runs as a single Yjs transaction (one update event for the whole paste)", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id));
    const b = addNode(sfmDoc, baseNode(root.id));
    addEdge(sfmDoc, baseEdge(root.id, { fromNode: a.id, toNode: b.id }));
    const clipboard = buildClipboard(sfmDoc, [a.id, b.id])!;

    let updateCount = 0;
    sfmDoc.doc.on("update", () => {
      updateCount += 1;
    });
    pasteClipboard(sfmDoc, root.id, clipboard);
    expect(updateCount).toBe(1);
  });
});

describe("deleteSelection", () => {
  function setUpTriangle(sfmDoc: SfmDocument, rootId: string) {
    const a = addNode(sfmDoc, baseNode(rootId, { x: 0, y: 0 }));
    const b = addNode(sfmDoc, baseNode(rootId, { x: 100, y: 0 }));
    const c = addNode(sfmDoc, baseNode(rootId, { x: 200, y: 0 }));
    const ab = addEdge(sfmDoc, baseEdge(rootId, { fromNode: a.id, toNode: b.id }));
    const bc = addEdge(sfmDoc, baseEdge(rootId, { fromNode: b.id, toNode: c.id, part: "Iron Ore" }));
    return { a, b, c, ab, bc };
  }

  it("is a no-op for an empty selection", () => {
    const { sfmDoc, root } = setUp();
    addNode(sfmDoc, baseNode(root.id));
    deleteSelection(sfmDoc, [], []);
    expect(listNodes(sfmDoc)).toHaveLength(1);
  });

  it("deletes selected nodes and cascades to every edge touching them, even edges to a non-selected node (no dangling refs)", () => {
    const { sfmDoc, root } = setUp();
    const { a, b, c, ab, bc } = setUpTriangle(sfmDoc, root.id);

    // Delete only `b` — it's a party to both edges, so both must go, even
    // though `a` and `c` (and the fact `bc` touches non-deleted `c`) aren't
    // themselves selected.
    deleteSelection(sfmDoc, [b.id], []);

    expect(listNodes(sfmDoc).map((n) => n.id).sort()).toEqual([a.id, c.id].sort());
    expect(listEdges(sfmDoc).map((e) => e.id)).not.toContain(ab.id);
    expect(listEdges(sfmDoc).map((e) => e.id)).not.toContain(bc.id);
    expect(listEdges(sfmDoc)).toHaveLength(0);
  });

  it("deletes an explicitly-selected edge even when neither endpoint node is selected", () => {
    const { sfmDoc, root } = setUp();
    const { a, b, c, ab, bc } = setUpTriangle(sfmDoc, root.id);

    deleteSelection(sfmDoc, [], [ab.id]);

    expect(listNodes(sfmDoc).map((n) => n.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(listEdges(sfmDoc).map((e) => e.id)).toEqual([bc.id]);
  });

  it("runs as a single Yjs transaction (one update event for a multi-node delete)", () => {
    const { sfmDoc, root } = setUp();
    const { a, b, c } = setUpTriangle(sfmDoc, root.id);

    let updateCount = 0;
    sfmDoc.doc.on("update", () => {
      updateCount += 1;
    });
    deleteSelection(sfmDoc, [a.id, b.id, c.id], []);
    expect(updateCount).toBe(1);
    expect(listNodes(sfmDoc)).toHaveLength(0);
    expect(listEdges(sfmDoc)).toHaveLength(0);
  });
});
