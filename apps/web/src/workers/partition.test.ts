import type { SolverEdge, SolverNode, SolverSnapshot } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { partitionSnapshot } from "./partition";

function node(id: string, overrides: Partial<SolverNode> = {}): SolverNode {
  return {
    id,
    recipe: "Iron Ingot",
    machine: "Smelter",
    purity: null,
    limit: null,
    limitMode: "machines",
    clock: null,
    shards: 0,
    ...overrides,
  };
}

function edge(id: string, fromNode: string, toNode: string): SolverEdge {
  return { id, part: "Iron Ingot", fromNode, fromPort: "out", toNode, toPort: "in" };
}

describe("partitionSnapshot", () => {
  it("produces one SolverComponent per connected component, containing only that component's own nodes/edges", () => {
    const snapshot: SolverSnapshot = {
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [edge("e1", "a", "b"), edge("e2", "c", "d")],
    };
    const components = partitionSnapshot(snapshot);
    expect(components).toHaveLength(2);
    expect(components[0]!.snapshot.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(components[0]!.snapshot.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(components[1]!.snapshot.nodes.map((n) => n.id)).toEqual(["c", "d"]);
    expect(components[1]!.snapshot.edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("gives two components with identical structure but different node ids different signatures", () => {
    const snapshot: SolverSnapshot = {
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [edge("e1", "a", "b"), edge("e2", "c", "d")],
    };
    const components = partitionSnapshot(snapshot);
    expect(components[0]!.signature).not.toBe(components[1]!.signature);
  });

  it("gives the same component the same signature across two independent calls with shuffled array order", () => {
    const snapshot: SolverSnapshot = {
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b")],
    };
    const reversedSnapshot: SolverSnapshot = {
      nodes: [...snapshot.nodes].reverse(),
      edges: [...snapshot.edges].reverse(),
    };
    const first = partitionSnapshot(snapshot);
    const second = partitionSnapshot(reversedSnapshot);
    expect(first[0]!.signature).toBe(second[0]!.signature);
  });

  it("changes a component's signature when any node field relevant to solving changes", () => {
    const before = partitionSnapshot({ nodes: [node("a", { limit: "1" })], edges: [] });
    const after = partitionSnapshot({ nodes: [node("a", { limit: "2" })], edges: [] });
    expect(before[0]!.signature).not.toBe(after[0]!.signature);
  });

  it("leaves an unrelated component's signature unchanged when a different component's node changes (the invalidation-precision property)", () => {
    const before = partitionSnapshot({
      nodes: [node("a", { limit: "1" }), node("b")],
      edges: [],
    });
    const after = partitionSnapshot({
      nodes: [node("a", { limit: "2" }), node("b")],
      edges: [],
    });
    const beforeB = before.find((c) => c.snapshot.nodes.some((n) => n.id === "b"))!;
    const afterB = after.find((c) => c.snapshot.nodes.some((n) => n.id === "b"))!;
    expect(beforeB.signature).toBe(afterB.signature);
  });

  it("gives both formerly-separate components a new signature when a boundary-crossing edge merges them", () => {
    const before = partitionSnapshot({
      nodes: [node("a"), node("b")],
      edges: [],
    });
    const componentA = before.find((c) => c.snapshot.nodes.some((n) => n.id === "a"))!;
    const componentB = before.find((c) => c.snapshot.nodes.some((n) => n.id === "b"))!;

    const after = partitionSnapshot({
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b")],
    });
    expect(after).toHaveLength(1);
    const merged = after[0]!;
    expect(merged.signature).not.toBe(componentA.signature);
    expect(merged.signature).not.toBe(componentB.signature);
  });

  it("returns an empty array for an empty snapshot", () => {
    expect(partitionSnapshot({ nodes: [], edges: [] })).toEqual([]);
  });

  // Regression: a Storage Container's synthetic intake/outflow pair
  // (`storagePassthrough.ts`) has NO real edge between them by design — the
  // producer's `capMachineCountAtNodeId` is the only link. Reproduced live
  // bug: connecting a new downstream node to the producer's side, once the
  // consumer's side was already cached from an earlier solve, left the
  // producer's `solve()` call with no idea the consumer node even existed,
  // permanently defaulting to the `ONE`-machine fallback — "works after a
  // fresh page load (cold cache, solved together once), broken after a live
  // edit (warm cache, solved separately)". These co-partitioning tests are
  // the fix's own regression coverage.
  describe("capMachineCountAtNodeId co-partitioning", () => {
    it("puts a capped node in the SAME component as its cap target even with no edge between them", () => {
      const components = partitionSnapshot({
        nodes: [node("consumer"), node("producer", { capMachineCountAtNodeId: "consumer" })],
        edges: [],
      });
      expect(components).toHaveLength(1);
      expect(components[0]!.snapshot.nodes.map((n) => n.id).sort()).toEqual(["consumer", "producer"]);
    });

    it("does NOT add a phantom edge for the cap link — the component's own edges stay exactly the real ones", () => {
      const components = partitionSnapshot({
        nodes: [node("consumer"), node("producer", { capMachineCountAtNodeId: "consumer" })],
        edges: [],
      });
      expect(components[0]!.snapshot.edges).toEqual([]);
    });

    it("a live edit on the capped (producer) side still keeps both nodes co-partitioned, so the consumer's resolved state is always visible to it", () => {
      // Simulates the reproduced scenario: "consumer" already has its own
      // real upstream edge (as if from an earlier solve); a NEW downstream
      // node/edge is added on the producer's side. Both must still land in
      // ONE component (and therefore one `solve()` call) despite the
      // producer/consumer pair itself having no edge.
      const components = partitionSnapshot({
        nodes: [node("upstream"), node("consumer"), node("producer", { capMachineCountAtNodeId: "consumer" }), node("downstream")],
        edges: [edge("e1", "upstream", "consumer"), edge("e2", "producer", "downstream")],
      });
      expect(components).toHaveLength(1);
      expect(components[0]!.snapshot.nodes.map((n) => n.id).sort()).toEqual(["consumer", "downstream", "producer", "upstream"]);
    });

    it("still separates two otherwise-unrelated cap pairs into their own components", () => {
      const components = partitionSnapshot({
        nodes: [
          node("consumer1"),
          node("producer1", { capMachineCountAtNodeId: "consumer1" }),
          node("consumer2"),
          node("producer2", { capMachineCountAtNodeId: "consumer2" }),
        ],
        edges: [],
      });
      expect(components).toHaveLength(2);
    });
  });
});
