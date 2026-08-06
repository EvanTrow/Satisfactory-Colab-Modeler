import { addContainer, addEdge, addNode, createDocument, type Container, type SfmDocument } from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import {
  boundaryPortId,
  buildContainerParentMap,
  computeOutpostPorts,
  isContainerWithinSubtree,
  resolveNodeLocation,
} from "./portMapping";

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

describe("buildContainerParentMap / resolveNodeLocation", () => {
  it("maps a node directly in the view to 'direct'", () => {
    const { root, outpost } = makeFixture();
    const parentOf = buildContainerParentMap([root, outpost]);
    expect(resolveNodeLocation(root.id, root.id, parentOf)).toEqual({ kind: "direct" });
  });

  it("maps a node inside an immediate child container to 'boundary'", () => {
    const { root, outpost } = makeFixture();
    const parentOf = buildContainerParentMap([root, outpost]);
    expect(resolveNodeLocation(outpost.id, root.id, parentOf)).toEqual({ kind: "boundary", containerId: outpost.id });
  });

  it("resolves through multiple nesting levels to the immediate child of the view", () => {
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
    const parentOf = buildContainerParentMap([root, outpost, nested]);
    // A node two levels deep, viewed from root, resolves to the *first*
    // child of root (the outpost), not the deeper nested container.
    expect(resolveNodeLocation(nested.id, root.id, parentOf)).toEqual({ kind: "boundary", containerId: outpost.id });
    // Viewed from the outpost itself, the same node resolves to 'direct'
    // one level further in (viewed from `outpost`, `nested` is the immediate child).
    expect(resolveNodeLocation(nested.id, outpost.id, parentOf)).toEqual({ kind: "boundary", containerId: nested.id });
  });

  it("returns null for a node outside the view's subtree entirely", () => {
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
    const parentOf = buildContainerParentMap([root, outpost, sibling]);
    // Viewed *from inside* the outpost, a node that's actually in a sibling
    // outpost isn't in this view's subtree at all.
    expect(resolveNodeLocation(sibling.id, outpost.id, parentOf)).toBeNull();
  });
});

describe("isContainerWithinSubtree", () => {
  it("is true for the container itself and any descendant", () => {
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
    const parentOf = buildContainerParentMap([root, outpost, nested]);
    expect(isContainerWithinSubtree(outpost.id, outpost.id, parentOf)).toBe(true);
    expect(isContainerWithinSubtree(nested.id, outpost.id, parentOf)).toBe(true);
  });

  it("is false for an ancestor or unrelated container", () => {
    const { root, outpost } = makeFixture();
    const parentOf = buildContainerParentMap([root, outpost]);
    expect(isContainerWithinSubtree(root.id, outpost.id, parentOf)).toBe(false);
  });
});

describe("computeOutpostPorts", () => {
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

  it("produces no ports when every edge is fully internal", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const a = addNode(sfmDoc, baseNode(outpost.id, "A"));
    const b = addNode(sfmDoc, baseNode(outpost.id, "B"));
    const edge = connect(sfmDoc, outpost.id, a.id, b.id);

    const parentOf = buildContainerParentMap([root, outpost]);
    const ports = computeOutpostPorts(outpost.id, [a, b], [edge], parentOf);
    expect(ports).toEqual([]);
  });

  it("produces no ports when every edge is fully outside the outpost", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const a = addNode(sfmDoc, baseNode(root.id, "A"));
    const b = addNode(sfmDoc, baseNode(root.id, "B"));
    const edge = connect(sfmDoc, root.id, a.id, b.id);
    const parentOf = buildContainerParentMap([root, outpost]);
    expect(computeOutpostPorts(outpost.id, [a, b], [edge], parentOf)).toEqual([]);
  });

  it("produces exactly one 'out' port for an edge leaving the outpost", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const inside = addNode(sfmDoc, baseNode(outpost.id, "Inside"));
    const outside = addNode(sfmDoc, baseNode(root.id, "Outside"));
    const edge = connect(sfmDoc, root.id, inside.id, outside.id, "Iron Ingot");
    const parentOf = buildContainerParentMap([root, outpost]);

    const ports = computeOutpostPorts(outpost.id, [inside, outside], [edge], parentOf);
    expect(ports).toEqual([
      { id: boundaryPortId(edge.id, "out"), direction: "out", part: "Iron Ingot", edgeId: edge.id, remoteNodeId: outside.id },
    ]);
  });

  it("produces exactly one 'in' port for an edge entering the outpost", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const outside = addNode(sfmDoc, baseNode(root.id, "Outside"));
    const inside = addNode(sfmDoc, baseNode(outpost.id, "Inside"));
    const edge = connect(sfmDoc, root.id, outside.id, inside.id, "Iron Ore");
    const parentOf = buildContainerParentMap([root, outpost]);

    const ports = computeOutpostPorts(outpost.id, [outside, inside], [edge], parentOf);
    expect(ports).toEqual([
      { id: boundaryPortId(edge.id, "in"), direction: "in", part: "Iron Ore", edgeId: edge.id, remoteNodeId: outside.id },
    ]);
  });

  it("stays correct as internal edges change: adding/removing an internal edge never adds a port", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const a = addNode(sfmDoc, baseNode(outpost.id, "A"));
    const b = addNode(sfmDoc, baseNode(outpost.id, "B"));
    const internal = connect(sfmDoc, outpost.id, a.id, b.id);
    const parentOf = buildContainerParentMap([root, outpost]);

    expect(computeOutpostPorts(outpost.id, [a, b], [internal], parentOf)).toEqual([]);

    // Now add a genuine crossing edge alongside the internal one — port count goes from 0 to 1, the internal edge still contributes nothing.
    const outside = addNode(sfmDoc, baseNode(root.id, "Outside"));
    const crossing = connect(sfmDoc, root.id, b.id, outside.id, "Copper Ore");
    const ports = computeOutpostPorts(outpost.id, [a, b, outside], [internal, crossing], parentOf);
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ edgeId: crossing.id, direction: "out" });
  });

  it("ignores edges with a dangling endpoint reference instead of throwing", () => {
    const { root, outpost } = makeFixture();
    const parentOf = buildContainerParentMap([root, outpost]);
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
    expect(computeOutpostPorts(outpost.id, [], [danglingEdge], parentOf)).toEqual([]);
  });

  it("gives two sibling outposts matching handle ids for the same connecting edge", () => {
    const { sfmDoc, root, outpost } = makeFixture();
    const sibling: Container = addContainer(sfmDoc, {
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

    const outpostPorts = computeOutpostPorts(outpost.id, [a, b], [edge], parentOf);
    const siblingPorts = computeOutpostPorts(sibling.id, [a, b], [edge], parentOf);
    expect(outpostPorts).toEqual([{ id: boundaryPortId(edge.id, "out"), direction: "out", part: "Water", edgeId: edge.id, remoteNodeId: b.id }]);
    expect(siblingPorts).toEqual([{ id: boundaryPortId(edge.id, "in"), direction: "in", part: "Water", edgeId: edge.id, remoteNodeId: a.id }]);
  });
});
