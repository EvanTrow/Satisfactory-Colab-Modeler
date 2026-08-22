import { addContainer, addEdge, addNode, createDocument, type SfmDocument } from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { boundaryPortId, buildContainerParentMap } from "./portMapping";
import { computeVisibleEdges } from "./visibleGraph";

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

function connect(sfmDoc: SfmDocument, containerId: string, fromNode: string, toNode: string, part = "Iron Ore") {
  return addEdge(sfmDoc, {
    containerId,
    part,
    fromNode,
    fromPort: `out:${part}`,
    toNode,
    toPort: `in:${part}`,
    style: null,
    labelPos: null,
  });
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

describe("computeVisibleEdges", () => {
  it("renders a normal edge directly when both endpoints are in the view", () => {
    const { sfmDoc, root } = makeFixture();
    const a = addNode(sfmDoc, baseNode(root.id, "A"));
    const b = addNode(sfmDoc, baseNode(root.id, "B"));
    const edge = connect(sfmDoc, root.id, a.id, b.id);
    const parentOf = buildContainerParentMap([root]);

    const visible = computeVisibleEdges(root.id, [a, b], [edge], parentOf);
    expect(visible).toEqual([
      { record: edge, projected: false, source: a.id, sourceHandle: edge.fromPort, target: b.id, targetHandle: edge.toPort },
    ]);
  });

  it("projects an edge from a real node to a child outpost's boundary handle", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const outside = addNode(sfmDoc, baseNode(root.id, "Outside"));
    const inside = addNode(sfmDoc, baseNode(outpost.id, "Inside"));
    const edge = connect(sfmDoc, root.id, outside.id, inside.id, "Iron Ore");
    const parentOf = buildContainerParentMap([root, outpost]);

    const visible = computeVisibleEdges(root.id, [outside, inside], [edge], parentOf);
    expect(visible).toEqual([
      {
        record: edge,
        projected: true,
        source: outside.id,
        sourceHandle: edge.fromPort,
        target: outpost.id,
        targetHandle: boundaryPortId(edge.id, "in"),
      },
    ]);
  });

  it("hides an edge that's fully internal to a child outpost from the parent view", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const a = addNode(sfmDoc, baseNode(outpost.id, "A"));
    const b = addNode(sfmDoc, baseNode(outpost.id, "B"));
    const edge = connect(sfmDoc, outpost.id, a.id, b.id);
    const parentOf = buildContainerParentMap([root, outpost]);

    expect(computeVisibleEdges(root.id, [a, b], [edge], parentOf)).toEqual([]);
    // ...but it renders directly once *inside* the outpost's own view.
    expect(computeVisibleEdges(outpost.id, [a, b], [edge], parentOf)).toEqual([
      { record: edge, projected: false, source: a.id, sourceHandle: edge.fromPort, target: b.id, targetHandle: edge.toPort },
    ]);
  });

  it("projects an edge between two sibling outposts onto both boundary nodes", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const sibling = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root.id,
      title: "Sibling",
      color: "#4b5563",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    const a = addNode(sfmDoc, baseNode(outpost.id, "A"));
    const b = addNode(sfmDoc, baseNode(sibling.id, "B"));
    const edge = connect(sfmDoc, root.id, a.id, b.id, "Water");
    const parentOf = buildContainerParentMap([root, outpost, sibling]);

    const visible = computeVisibleEdges(root.id, [a, b], [edge], parentOf);
    expect(visible).toEqual([
      {
        record: edge,
        projected: true,
        source: outpost.id,
        sourceHandle: boundaryPortId(edge.id, "out"),
        target: sibling.id,
        targetHandle: boundaryPortId(edge.id, "in"),
      },
    ]);
  });

  it("hides an edge that isn't part of this view's subtree at all", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const sibling = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root.id,
      title: "Sibling",
      color: "#4b5563",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    const a = addNode(sfmDoc, baseNode(outpost.id, "A"));
    const b = addNode(sfmDoc, baseNode(sibling.id, "B"));
    const edge = connect(sfmDoc, root.id, a.id, b.id);
    const parentOf = buildContainerParentMap([root, outpost, sibling]);

    // Viewed from *inside* the outpost, node `b` (in the sibling) isn't reachable at all.
    expect(computeVisibleEdges(outpost.id, [a, b], [edge], parentOf)).toEqual([]);
  });

  it("Outpost/Blueprint I/O rework: a DIRECT edge into the locked Outputs node uses the real ${dir}:${part} handle, not its raw stored (possibly wildcard) port", () => {
    // The exact bug this regression test locks in: dragging a NEW connection
    // onto the always-present "+" row bootstraps an edge whose OWN toPort
    // stays the literal wildcard sentinel forever (`edges/connectionLogic.ts`'s
    // "wildcards never get renamed" convention) — but the Outputs node's
    // RENDERED row for that part uses the real, freshly-computed
    // `${dir}:${part}` id (`OutpostIoNode.tsx`). Viewed from INSIDE the
    // outpost, this edge (producer -> Outputs node) is "direct" (both
    // endpoints in view) — using the raw `toPort` here would target the
    // WRONG (wildcard) handle instead of the named row's real one.
    const { sfmDoc, root, outpost } = makeFixture();
    const producer = addNode(sfmDoc, baseNode(outpost.id, "Producer"));
    const outputsNode = addNode(sfmDoc, { ...baseNode(outpost.id, "Outputs"), kind: "outpost-output" });
    const edge = addEdge(sfmDoc, {
      containerId: outpost.id,
      part: "Heat Sink",
      fromNode: producer.id,
      fromPort: "out:Heat Sink",
      toNode: outputsNode.id,
      toPort: "in:*", // the raw stored port — permanently the wildcard sentinel.
      style: null,
      labelPos: null,
    });
    const parentOf = buildContainerParentMap([root, outpost]);

    const visible = computeVisibleEdges(outpost.id, [producer, outputsNode], [edge], parentOf);
    expect(visible).toEqual([
      {
        record: edge,
        projected: false,
        source: producer.id,
        sourceHandle: "out:Heat Sink",
        target: outputsNode.id,
        targetHandle: "in:Heat Sink", // NOT "in:*" — the real, named handle the row actually renders.
      },
    ]);
  });

  it("Outpost/Blueprint I/O rework: a DIRECT edge OUT of the locked Inputs node uses the real handle too", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const inputsNode = addNode(sfmDoc, { ...baseNode(outpost.id, "Inputs"), kind: "outpost-input" });
    const consumer = addNode(sfmDoc, baseNode(outpost.id, "Consumer"));
    const edge = addEdge(sfmDoc, {
      containerId: outpost.id,
      part: "Iron Ore",
      fromNode: inputsNode.id,
      fromPort: "out:*",
      toNode: consumer.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    const parentOf = buildContainerParentMap([root, outpost]);

    const visible = computeVisibleEdges(outpost.id, [inputsNode, consumer], [edge], parentOf);
    expect(visible[0]).toMatchObject({ sourceHandle: "out:Iron Ore", targetHandle: "in:Iron Ore" });
  });

  it("skips an edge with a dangling endpoint reference instead of throwing", () => {
    const { root } = makeFixture();
    const parentOf = buildContainerParentMap([root]);
    const danglingEdge = {
      id: "e_dangling",
      containerId: root.id,
      part: "Iron Ore",
      fromNode: "n_missing",
      fromPort: "out:Iron Ore",
      toNode: "n_also_missing",
      toPort: "in:Iron Ore",
      waypoints: [],
      style: null,
      labelPos: null,
    };
    expect(computeVisibleEdges(root.id, [], [danglingEdge], parentOf)).toEqual([]);
  });
});
