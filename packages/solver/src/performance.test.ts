// Acceptance criterion: "A ~200-node synthetic snapshot solves in well
// under 200ms synchronously" (this job's own acceptance criteria, echoing
// PLAN.md §4's Phase-4 exit criterion and §9's 500-node/800-edge budget).
// This package doesn't own the worker/debounce infra (Job 018) — this test
// just proves the raw synchronous `solve()` call itself is fast enough to
// support that later budget.
import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverEdge, SolverNode, SolverSnapshot } from "./snapshot";

function buildSyntheticSnapshot(chainCount: number): SolverSnapshot {
  const nodes: SolverNode[] = [];
  const edges: SolverEdge[] = [];
  for (let i = 0; i < chainCount; i++) {
    const minerId = `miner-${i}`;
    const smelterId = `smelter-${i}`;
    nodes.push({
      id: minerId,
      recipe: "Iron Ore",
      machine: "Miner Mk.2",
      purity: i % 3 === 0 ? "pure" : i % 3 === 1 ? "normal" : "impure",
      limit: String(30 + i),
      limitMode: "ppm",
      clock: null,
      shards: 0,
    });
    nodes.push({
      id: smelterId,
      recipe: "Iron Ingot",
      machine: "Smelter",
      purity: null,
      // Every other chain leaves the consumer unconstrained, forcing the
      // Basic-mode graph propagation path (not just per-node pin math) to
      // run across the whole synthetic snapshot.
      limit: i % 2 === 0 ? null : String(1 + (i % 5)),
      limitMode: "machines",
      clock: i % 2 === 0 ? null : String(50 + (i % 100)),
      shards: 0,
    });
    edges.push({
      id: `edge-${i}`,
      part: "Iron Ore",
      fromNode: minerId,
      fromPort: "out",
      toNode: smelterId,
      toPort: "in",
    });
  }
  return { nodes, edges };
}

describe("performance", () => {
  it("solves a ~200-node synthetic snapshot in well under 200ms (Basic mode)", () => {
    const snapshot = buildSyntheticSnapshot(100); // 100 chains x 2 nodes = 200 nodes
    expect(snapshot.nodes).toHaveLength(200);

    // Warm up (JIT) once so the assertion measures steady-state performance,
    // not first-call compilation.
    solve(snapshot, "basic", defaultGameData);

    const start = performance.now();
    const result = solve(snapshot, "basic", defaultGameData);
    const elapsed = performance.now() - start;

    expect(result.nodes).toHaveLength(200);
    expect(elapsed).toBeLessThan(200);
  });

  it("solves the same synthetic snapshot in Manual mode well under 200ms", () => {
    const snapshot = buildSyntheticSnapshot(100);
    solve(snapshot, "manual", defaultGameData);
    const start = performance.now();
    const result = solve(snapshot, "manual", defaultGameData);
    const elapsed = performance.now() - start;
    expect(result.nodes).toHaveLength(200);
    expect(elapsed).toBeLessThan(200);
  });
});
