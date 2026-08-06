// PLAN.md §5 point 4's determinism requirement for Basic mode, tested
// directly: the SAME logical graph, submitted with different node/edge
// array orders, must produce byte-identical results. See `basic.ts`'s
// header comment for the algorithm this is verifying.
import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverEdge, SolverNode } from "./snapshot";

function shuffled<T>(items: readonly T[], seed: number): T[] {
  // Small deterministic (test-only) shuffle — a fixed seed, not `Math.random`,
  // so a failing test is reproducible.
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

describe("Basic mode determinism (PLAN.md §5 point 4)", () => {
  it("produces identical output for a chain graph regardless of node/edge array order", () => {
    const nodes: SolverNode[] = [
      {
        id: "n-miner",
        recipe: "Iron Ore",
        machine: "Miner Mk.2",
        purity: "normal",
        limit: "1",
        limitMode: "machines",
        clock: null,
        shards: 0,
      },
      {
        id: "n-smelter-a",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: null,
        limitMode: "machines",
        clock: null,
        shards: 0,
      },
      {
        id: "n-smelter-b",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: null,
        limitMode: "machines",
        clock: "50",
        shards: 0,
      },
    ];
    const edges: SolverEdge[] = [
      { id: "e-1", part: "Iron Ore", fromNode: "n-miner", fromPort: "out", toNode: "n-smelter-a", toPort: "in" },
      { id: "e-2", part: "Iron Ore", fromNode: "n-miner", fromPort: "out", toNode: "n-smelter-b", toPort: "in" },
    ];

    const orderings = [
      { nodes, edges },
      { nodes: [...nodes].reverse(), edges: [...edges].reverse() },
      { nodes: shuffled(nodes, 7), edges: shuffled(edges, 13) },
      { nodes: shuffled(nodes, 99), edges: shuffled(edges, 4) },
    ];

    const results = orderings.map((snapshot) => solve(snapshot, "basic", defaultGameData));
    const canonical = JSON.stringify(results[0]);
    for (const result of results.slice(1)) {
      expect(JSON.stringify(result)).toBe(canonical);
    }
    // Sanity: this actually exercised the fan-out/even-split path, not a
    // trivially-empty graph.
    expect(results[0]!.valid).toBe(true);
    expect(results[0]!.nodes).toHaveLength(3);
  });

  it("splits an unconstrained fan-out evenly and deterministically regardless of edge order", () => {
    // One pinned Miner feeding TWO unconstrained Smelters with no priority
    // information at all — PLAN.md §2's "No" on splitter/merger preference
    // modeling for Basic mode means each gets exactly half, and that must
    // hold no matter which order the two edges appear in the snapshot.
    const nodes: SolverNode[] = [
      {
        id: "producer",
        recipe: "Iron Ore",
        machine: "Miner Mk.1",
        purity: "normal",
        limit: "60", // ppm-equivalent via machine count 1 at Mk.1 Normal = 60/min
        limitMode: "ppm",
        clock: null,
        shards: 0,
      },
      {
        id: "consumer-a",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: null,
        limitMode: "machines",
        clock: null,
        shards: 0,
      },
      {
        id: "consumer-b",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: null,
        limitMode: "machines",
        clock: null,
        shards: 0,
      },
    ];
    const edgesForward: SolverEdge[] = [
      { id: "edge-a", part: "Iron Ore", fromNode: "producer", fromPort: "out", toNode: "consumer-a", toPort: "in" },
      { id: "edge-b", part: "Iron Ore", fromNode: "producer", fromPort: "out", toNode: "consumer-b", toPort: "in" },
    ];
    const edgesReversed = [...edgesForward].reverse();

    const forward = solve({ nodes, edges: edgesForward }, "basic", defaultGameData);
    const reversed = solve({ nodes: [...nodes].reverse(), edges: edgesReversed }, "basic", defaultGameData);

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));

    const a = forward.nodes.find((n) => n.nodeId === "consumer-a")!;
    const b = forward.nodes.find((n) => n.nodeId === "consumer-b")!;
    // 60/min split evenly two ways = 30/min each = exactly 1 machine each
    // (Smelter's Iron Ingot recipe runs at 30/min per machine at 100% clock).
    expect(a.machineCount).toBe(b.machineCount);
    expect(a.partRates["Iron Ingot"]).toBe(b.partRates["Iron Ingot"]);
    expect(forward.valid).toBe(true);
  });
});
