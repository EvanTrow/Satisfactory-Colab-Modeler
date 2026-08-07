// Acceptance criterion: "Cancelling a slow Full-mode solve actually stops
// computation promptly (verify via a timing test — cancellation should
// take effect within one LP iteration, not run to completion regardless)."
// `waterFill.test.ts` already proves this at the level of ONE group's
// water-fill loop (a hand-verified 3-round staircase, cancelled after round
// 1). This file proves the same property at `solveFull()`'s own level,
// across a graph large enough that running to completion is measurably
// slower than cancelling early — genuine mid-computation cancellation, not
// a post-hoc discard of an already-finished result.
import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";
import { solveFull } from "./full";
import type { SolverEdge, SolverNode, SolverSnapshot } from "./snapshot";

/**
 * `count` independent 3-node clusters (1 pinned Miner splitting evenly into
 * 2 unconstrained Smelters). Independent clusters are resolvable within a
 * SINGLE propagation pass, but `computeGroupAllocations` still has to walk
 * every cluster's own splitter group one at a time (a real per-group
 * `checkCancelled` + `waterFillGroup` call each) — this is deliberately
 * NOT a deep chain (Basic mode's own multi-pass worst case): the point here
 * is to prove cancellation is checked WITHIN a single pass's group-by-group
 * work, not just between passes.
 */
function buildManyClusters(count: number): SolverSnapshot {
  const nodes: SolverNode[] = [];
  const edges: SolverEdge[] = [];
  for (let i = 0; i < count; i++) {
    const minerId = `miner-${i}`;
    const smelterAId = `smelter-${i}-a`;
    const smelterBId = `smelter-${i}-b`;
    nodes.push({
      id: minerId,
      recipe: "Iron Ore",
      machine: "Miner Mk.1",
      purity: "normal",
      limit: "60",
      limitMode: "ppm",
      clock: null,
      shards: 0,
    });
    nodes.push({ id: smelterAId, recipe: "Iron Ingot", machine: "Smelter", purity: null, limit: null, limitMode: "machines", clock: null, shards: 0 });
    nodes.push({ id: smelterBId, recipe: "Iron Ingot", machine: "Smelter", purity: null, limit: null, limitMode: "machines", clock: null, shards: 0 });
    edges.push({ id: `edge-${i}-a`, part: "Iron Ore", fromNode: minerId, fromPort: "out", toNode: smelterAId, toPort: "in" });
    edges.push({ id: `edge-${i}-b`, part: "Iron Ore", fromNode: minerId, fromPort: "out", toNode: smelterBId, toPort: "in" });
  }
  return { nodes, edges };
}

describe("Full mode cancellation", () => {
  it("returns a defined cancelled result instead of throwing, with empty nodes/edges", () => {
    const snapshot = buildManyClusters(500);
    const signal = { aborted: false };
    let calls = 0;
    const result = solveFull(snapshot, defaultGameData, {
      signal,
      onProgress: () => {
        calls += 1;
        if (calls === 3) signal.aborted = true;
      },
    });

    expect(result.cancelled).toBe(true);
    expect(result.mode).toBe("full");
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.valid).toBe(false);
    expect(result.warnings).toContain("solve cancelled");
  });

  it("stops after only a handful of the graph's splitter groups, not all of them", () => {
    // 500 clusters -> 500 independent producer-owned splitter groups that
    // `computeGroupAllocations` would otherwise walk in full.
    const snapshot = buildManyClusters(500);
    const signal = { aborted: false };
    let calls = 0;
    solveFull(snapshot, defaultGameData, {
      signal,
      onProgress: () => {
        calls += 1;
        if (calls === 3) signal.aborted = true;
      },
    });
    // Cancellation took effect at the top of the very next group-loop
    // iteration/round after the 3rd progress callback — nowhere near the
    // ~500 groups a full run would have to process.
    expect(calls).toBeLessThan(10);
  });

  it("never reports cancellation when the signal is never aborted", () => {
    const snapshot = buildManyClusters(50);
    const result = solveFull(snapshot, defaultGameData, {});
    expect(result.cancelled).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(result.nodes).toHaveLength(150);
  });

  it("a cancelled solve returns dramatically faster than the same graph solved to completion", () => {
    const snapshot = buildManyClusters(4000);

    // Warm up (JIT) once so the timing comparison measures steady-state
    // performance, not first-call compilation cost.
    solveFull(snapshot, defaultGameData, {});

    const completeStart = performance.now();
    const completeResult = solveFull(snapshot, defaultGameData, {});
    const completeMs = performance.now() - completeStart;
    expect(completeResult.cancelled).toBeUndefined();

    const signal = { aborted: false };
    let calls = 0;
    const cancelStart = performance.now();
    const cancelledResult = solveFull(snapshot, defaultGameData, {
      signal,
      onProgress: () => {
        calls += 1;
        if (calls === 3) signal.aborted = true;
      },
    });
    const cancelMs = performance.now() - cancelStart;

    expect(cancelledResult.cancelled).toBe(true);
    // Generous margin (not a tight timing assertion, to avoid flakiness on
    // a loaded CI machine) — the point is "dramatically less," not an exact
    // ratio: cancelling after ~3 of 4000 groups' worth of work should never
    // be in the same order of magnitude as finishing all of them.
    expect(cancelMs).toBeLessThan(completeMs / 3);
  });
});
