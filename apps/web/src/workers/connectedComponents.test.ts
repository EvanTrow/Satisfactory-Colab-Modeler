import { describe, expect, it } from "vitest";
import { computeConnectedComponents, type ComponentEdgeLike } from "./connectedComponents";

function edge(id: string, fromNode: string, toNode: string): ComponentEdgeLike {
  return { id, fromNode, toNode };
}

describe("computeConnectedComponents", () => {
  it("puts every node with no edges into its own singleton component", () => {
    const components = computeConnectedComponents(["a", "b", "c"], []);
    expect(components).toHaveLength(3);
    expect(components.map((c) => c.nodeIds)).toEqual([["a"], ["b"], ["c"]]);
    expect(components.every((c) => c.edgeIds.length === 0)).toBe(true);
  });

  it("groups a simple chain into one component", () => {
    const components = computeConnectedComponents(
      ["a", "b", "c"],
      [edge("e1", "a", "b"), edge("e2", "b", "c")],
    );
    expect(components).toHaveLength(1);
    expect(components[0]!.nodeIds).toEqual(["a", "b", "c"]);
    expect(components[0]!.edgeIds).toEqual(["e1", "e2"]);
  });

  it("keeps two disconnected chains as two separate components (the whole-graph partition, not an outpost-boundary partition)", () => {
    const components = computeConnectedComponents(
      ["a", "b", "c", "d"],
      [edge("e1", "a", "b"), edge("e2", "c", "d")],
    );
    expect(components).toHaveLength(2);
    expect(components.map((c) => c.nodeIds)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(components.map((c) => c.edgeIds)).toEqual([["e1"], ["e2"]]);
  });

  it("merges two components into one the moment a connecting edge appears", () => {
    const before = computeConnectedComponents(
      ["a", "b", "c", "d"],
      [edge("e1", "a", "b"), edge("e2", "c", "d")],
    );
    expect(before).toHaveLength(2);

    const after = computeConnectedComponents(
      ["a", "b", "c", "d"],
      [edge("e1", "a", "b"), edge("e2", "c", "d"), edge("e3", "b", "c")],
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.nodeIds).toEqual(["a", "b", "c", "d"]);
    expect(after[0]!.edgeIds).toEqual(["e1", "e2", "e3"]);
  });

  it("is deterministic regardless of node/edge array order", () => {
    const nodeIds = ["x1", "x2", "x3", "x4", "x5"];
    const edges = [edge("e1", "x1", "x2"), edge("e2", "x2", "x3"), edge("e3", "x4", "x5")];

    const forward = computeConnectedComponents(nodeIds, edges);
    const shuffled = computeConnectedComponents([...nodeIds].reverse(), [...edges].reverse());

    expect(shuffled).toEqual(forward);
  });

  it("ignores an edge referencing a node id outside the given node set", () => {
    const components = computeConnectedComponents(["a", "b"], [edge("e1", "a", "ghost")]);
    expect(components).toHaveLength(2);
    expect(components.every((c) => c.edgeIds.length === 0)).toBe(true);
  });

  it("handles a many-node star graph (one pinned hub, several unconnected-to-each-other leaves) as a single component", () => {
    const nodeIds = ["hub", "leaf1", "leaf2", "leaf3", "leaf4"];
    const edges = nodeIds.slice(1).map((leaf, i) => edge(`e${i}`, "hub", leaf));
    const components = computeConnectedComponents(nodeIds, edges);
    expect(components).toHaveLength(1);
    expect(components[0]!.nodeIds).toEqual([...nodeIds].sort());
  });
});
