// Full mode's determinism guarantee — PLAN.md §5 point 4's requirement
// doesn't relax for Full mode just because it's an LP (see
// jobs/023-full-calculator.md's own explicit callout: "an LP can have
// multiple optimal solutions ... so your formulation needs its own
// deterministic pivot/tie-breaking rule"). This follows
// `determinism.test.ts`'s existing pattern for Basic mode exactly: the SAME
// logical graph, submitted with shuffled/reversed node and edge array
// order, must produce byte-identical output.
import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverEdge, SolverNode } from "./snapshot";

function shuffled<T>(items: readonly T[], seed: number): T[] {
  // Same small deterministic (test-only) shuffle `determinism.test.ts` uses
  // — a fixed seed, not `Math.random`, so a failing test is reproducible.
  const arr = [...items];
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

describe("Full mode determinism (PLAN.md §5 point 4, extended to the LP formulation)", () => {
  it("produces identical output for an even-split-with-capacity fan-out regardless of node/edge array order", () => {
    const nodes: SolverNode[] = [
      {
        id: "producer",
        recipe: "Iron Ore",
        machine: "Miner Mk.1",
        purity: "normal",
        limit: "90",
        limitMode: "ppm",
        clock: null,
        shards: 0,
      },
      {
        id: "consumer-capped",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: "10",
        limitMode: "ppm",
        clock: null,
        shards: 0,
      },
      {
        id: "consumer-open-a",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: null,
        limitMode: "machines",
        clock: null,
        shards: 0,
      },
      {
        id: "consumer-open-b",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: null,
        limitMode: "machines",
        clock: null,
        shards: 0,
      },
    ];
    const edges: SolverEdge[] = [
      { id: "e-1", part: "Iron Ore", fromNode: "producer", fromPort: "out", toNode: "consumer-capped", toPort: "in" },
      { id: "e-2", part: "Iron Ore", fromNode: "producer", fromPort: "out", toNode: "consumer-open-a", toPort: "in" },
      { id: "e-3", part: "Iron Ore", fromNode: "producer", fromPort: "out", toNode: "consumer-open-b", toPort: "in" },
    ];

    const orderings = [
      { nodes, edges },
      { nodes: [...nodes].reverse(), edges: [...edges].reverse() },
      { nodes: shuffled(nodes, 7), edges: shuffled(edges, 13) },
      { nodes: shuffled(nodes, 99), edges: shuffled(edges, 4) },
    ];

    const results = orderings.map((snapshot) => solve(snapshot, "full", defaultGameData));
    const canonical = JSON.stringify(results[0]);
    for (const result of results.slice(1)) {
      expect(JSON.stringify(result)).toBe(canonical);
    }
    expect(results[0]!.valid).toBe(true);
    expect(results[0]!.nodes).toHaveLength(4);
  });

  it("produces identical output for a two-tier priority splitter regardless of node/edge array order", () => {
    const nodes: SolverNode[] = [
      {
        id: "producer",
        recipe: "Iron Ore",
        machine: "Miner Mk.1",
        purity: "normal",
        limit: "60",
        limitMode: "ppm",
        clock: null,
        shards: 0,
      },
      {
        id: "top-consumer",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: "20",
        limitMode: "ppm",
        clock: null,
        shards: 0,
      },
      {
        id: "bottom-consumer",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: null,
        limitMode: "machines",
        clock: null,
        shards: 0,
      },
    ];
    const edges: SolverEdge[] = [
      {
        id: "e-top",
        part: "Iron Ore",
        fromNode: "producer",
        fromPort: "out",
        toNode: "top-consumer",
        toPort: "in",
        priorityTier: "top",
      },
      {
        id: "e-bottom",
        part: "Iron Ore",
        fromNode: "producer",
        fromPort: "out",
        toNode: "bottom-consumer",
        toPort: "in",
        priorityTier: "bottom",
      },
    ];

    const orderings = [
      { nodes, edges },
      { nodes: [...nodes].reverse(), edges: [...edges].reverse() },
      { nodes: shuffled(nodes, 21), edges: shuffled(edges, 3) },
    ];

    const results = orderings.map((snapshot) => solve(snapshot, "full", defaultGameData));
    const canonical = JSON.stringify(results[0]);
    for (const result of results.slice(1)) {
      expect(JSON.stringify(result)).toBe(canonical);
    }
    expect(results[0]!.valid).toBe(true);

    const top = results[0]!.nodes.find((n) => n.nodeId === "top-consumer")!;
    const bottom = results[0]!.nodes.find((n) => n.nodeId === "bottom-consumer")!;
    expect(top.partRates["Iron Ingot"]).toBe("20");
    expect(bottom.partRates["Iron Ingot"]).toBe("40");
  });
});
