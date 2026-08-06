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
