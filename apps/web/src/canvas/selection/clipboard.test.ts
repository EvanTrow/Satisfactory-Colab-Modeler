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
  getNode,
  listContainers,
  listEdges,
  listNodes,
} from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { OUTPOST_INPUT_KIND, OUTPOST_OUTPUT_KIND, ensureOutpostIoNodes, outpostInputNodeId, outpostOutputNodeId } from "../outposts/io";
import {
  DEFAULT_PASTE_OFFSET,
  buildClipboard,
  clipboardCentroid,
  deleteSelection,
  deserializeClipboard,
  pasteClipboard,
  pasteOffsetForCenter,
  serializeClipboard,
} from "./clipboard";

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
    splitterVariant: null,
    mergerVariant: null,
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

describe("serializeClipboard / deserializeClipboard", () => {
  it("round-trips a clipboard payload through system-clipboard text", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0 }));
    const b = addNode(sfmDoc, baseNode(root.id, { x: 100, y: 50 }));
    addEdge(sfmDoc, baseEdge(root.id, { fromNode: a.id, toNode: b.id }));
    const clipboard = buildClipboard(sfmDoc, [a.id, b.id])!;

    const text = serializeClipboard(clipboard);
    expect(typeof text).toBe("string");
    const roundTripped = deserializeClipboard(text);

    expect(roundTripped).toEqual(clipboard);
  });

  it("returns null for text that isn't valid base64", () => {
    expect(deserializeClipboard("just some plain text, with punctuation!")).toBeNull();
  });

  it("returns null for base64 that doesn't decode to JSON", () => {
    // Valid base64 (all-lowercase-letter strings happen to decode cleanly),
    // but the decoded bytes aren't JSON — exercises the `JSON.parse` guard
    // specifically, distinct from the base64-decode guard above.
    expect(deserializeClipboard(btoa("thisisnotjsonatall"))).toBeNull();
  });

  it("returns null for well-formed JSON that isn't this app's clipboard envelope", () => {
    expect(deserializeClipboard(btoa(JSON.stringify({ hello: "world" })))).toBeNull();
    expect(deserializeClipboard(btoa(JSON.stringify({ nodes: [], edges: [] })))).toBeNull();
  });

  it("returns null for a clipboard envelope from an unsupported schema version", () => {
    const encoded = btoa(JSON.stringify({ app: "scm.clipboard", version: 999, nodes: [], edges: [] }));
    expect(deserializeClipboard(encoded)).toBeNull();
  });

  it("returns null when a node record is missing required fields", () => {
    const encoded = btoa(
      JSON.stringify({
        app: "scm.clipboard",
        version: 1,
        nodes: [{ id: "n1" }],
        edges: [],
      }),
    );
    expect(deserializeClipboard(encoded)).toBeNull();
  });
});

describe("clipboardCentroid / pasteOffsetForCenter", () => {
  it("returns null for an empty node list", () => {
    expect(clipboardCentroid([])).toBeNull();
  });

  it("averages node positions", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0 }));
    const b = addNode(sfmDoc, baseNode(root.id, { x: 100, y: 50 }));
    const clipboard = buildClipboard(sfmDoc, [a.id, b.id])!;

    expect(clipboardCentroid(clipboard.nodes)).toEqual({ x: 50, y: 25 });
  });

  it("falls back to DEFAULT_PASTE_OFFSET when there's no known viewport center", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0 }));
    const clipboard = buildClipboard(sfmDoc, [a.id])!;

    expect(pasteOffsetForCenter(clipboard, null)).toEqual(DEFAULT_PASTE_OFFSET);
  });

  it("falls back to DEFAULT_PASTE_OFFSET for an empty clipboard even with a known center", () => {
    expect(pasteOffsetForCenter({ nodes: [], containers: [] }, { x: 500, y: 500 })).toEqual(DEFAULT_PASTE_OFFSET);
  });

  it("computes the offset that moves the copied group's centroid onto the given center", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, baseNode(root.id, { x: 0, y: 0 }));
    const b = addNode(sfmDoc, baseNode(root.id, { x: 100, y: 50 }));
    const clipboard = buildClipboard(sfmDoc, [a.id, b.id])!;

    const offset = pasteOffsetForCenter(clipboard, { x: 1000, y: 2000 });
    expect(offset).toEqual({ dx: 950, dy: 1975 }); // 1000-50, 2000-25

    const result = pasteClipboard(sfmDoc, root.id, clipboard, offset);
    const pastedNodes = result.nodeIds.map((id) => listNodes(sfmDoc).find((n) => n.id === id)!);
    expect(clipboardCentroid(pastedNodes)).toEqual({ x: 1000, y: 2000 });
  });
});

describe("outposts", () => {
  it("buildClipboard selecting only the outpost boundary id pulls in its locked I/O nodes and inner contents", () => {
    const { sfmDoc, root } = setUp();
    const outpost = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root.id,
      title: "Outpost",
      color: "#d97706",
      x: 500,
      y: 500,
    });
    ensureOutpostIoNodes(sfmDoc, outpost.id, outpost.color);
    const inner = addNode(sfmDoc, baseNode(outpost.id, { x: 0, y: 0 }));
    addEdge(
      sfmDoc,
      baseEdge(outpost.id, { fromNode: outpostInputNodeId(outpost.id), toNode: inner.id }),
    );

    // Only the outpost's own boundary id is "selected" — none of its
    // contents are individually selected, matching what a marquee/click
    // selection of the collapsed outpost card looks like.
    const clipboard = buildClipboard(sfmDoc, [outpost.id]);

    expect(clipboard).not.toBeNull();
    expect(clipboard!.containers).toEqual([outpost]);
    expect(clipboard!.nodes.map((n) => n.id).sort()).toEqual(
      [outpostInputNodeId(outpost.id), outpostOutputNodeId(outpost.id), inner.id].sort(),
    );
    expect(clipboard!.edges).toHaveLength(1);
  });

  it("pasteClipboard duplicates an outpost with a fresh container id, re-derived locked I/O ids, and remapped inner nodes/edges", () => {
    const { sfmDoc, root } = setUp();
    const outpost = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root.id,
      title: "Outpost",
      color: "#d97706",
      x: 500,
      y: 500,
    });
    ensureOutpostIoNodes(sfmDoc, outpost.id, outpost.color);
    const inner = addNode(sfmDoc, baseNode(outpost.id, { x: 10, y: 10 }));
    addEdge(sfmDoc, baseEdge(outpost.id, { fromNode: outpostInputNodeId(outpost.id), toNode: inner.id }));

    const clipboard = buildClipboard(sfmDoc, [outpost.id])!;
    const result = pasteClipboard(sfmDoc, root.id, clipboard, { dx: 40, dy: 40 });

    expect(result.containerIds).toHaveLength(1);
    const newOutpostId = result.containerIds[0]!;
    expect(newOutpostId).not.toBe(outpost.id);

    const newContainer = listContainers(sfmDoc).find((c) => c.id === newOutpostId)!;
    expect(newContainer.parentId).toBe(root.id);
    // Top-level container: shifted by the paste offset, same as a plain node would be.
    expect(newContainer).toMatchObject({ x: 540, y: 540, kind: "outpost", title: "Outpost" });

    // The pasted outpost's locked I/O nodes have deterministic ids derived
    // from ITS OWN new container id — not a random id, and not reused from
    // the original outpost (which would corrupt both on any future write).
    const newInputId = outpostInputNodeId(newOutpostId);
    const newOutputId = outpostOutputNodeId(newOutpostId);
    expect(result.nodeIds).toContain(newInputId);
    expect(result.nodeIds).toContain(newOutputId);
    expect(newInputId).not.toBe(outpostInputNodeId(outpost.id));

    const pastedNodes = listNodes(sfmDoc).filter((n) => n.containerId === newOutpostId);
    expect(pastedNodes.map((n) => n.kind).sort()).toEqual([OUTPOST_INPUT_KIND, OUTPOST_OUTPUT_KIND, "recipe"].sort());
    const pastedInner = pastedNodes.find((n) => n.kind === "recipe")!;
    // Inner node keeps its original position relative to its (also copied,
    // identically un-shifted) container — it does NOT also get the
    // top-level paste offset added on top.
    expect(pastedInner).toMatchObject({ x: 10, y: 10 });

    const pastedEdge = listEdges(sfmDoc).find((e) => e.containerId === newOutpostId)!;
    expect(pastedEdge).toBeDefined();
    expect(pastedEdge.fromNode).toBe(newInputId);
    expect(pastedEdge.toNode).toBe(pastedInner.id);

    // Original outpost and its contents are completely untouched — no
    // shared references between the two copies.
    expect(listContainers(sfmDoc)).toHaveLength(3); // root + original outpost + pasted copy
    expect(getNode(sfmDoc, outpostInputNodeId(outpost.id))).toBeDefined();
    expect(listNodes(sfmDoc).filter((n) => n.containerId === outpost.id)).toHaveLength(3);
  });

  it("pasteClipboard duplicates a nested outpost-in-outpost, parenting the copied child under the copied parent", () => {
    const { sfmDoc, root } = setUp();
    const outer = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root.id,
      title: "Outer",
      color: "#d97706",
      x: 0,
      y: 0,
    });
    const inner = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: outer.id,
      title: "Inner",
      color: "#d97706",
      x: 20,
      y: 20,
    });

    const clipboard = buildClipboard(sfmDoc, [outer.id])!;
    expect(clipboard.containers.map((c) => c.id)).toEqual([outer.id, inner.id]);

    const result = pasteClipboard(sfmDoc, root.id, clipboard, { dx: 100, dy: 100 });
    expect(result.containerIds).toHaveLength(2);
    const [newOuterId, newInnerId] = result.containerIds;

    const newOuter = listContainers(sfmDoc).find((c) => c.id === newOuterId)!;
    const newInner = listContainers(sfmDoc).find((c) => c.id === newInnerId)!;
    expect(newOuter.parentId).toBe(root.id);
    expect(newInner.parentId).toBe(newOuterId);
    // Outer (top-level) shifts by the offset; inner (nested) keeps its
    // original position relative to its own copied parent.
    expect(newOuter).toMatchObject({ x: 100, y: 100 });
    expect(newInner).toMatchObject({ x: 20, y: 20 });
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
