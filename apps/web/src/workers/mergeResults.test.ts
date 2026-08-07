import { defaultGameData } from "@scm/gamedata";
import { solve, type SolverSnapshot } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { mergeComponentResults, noneResult, splitResultByComponents } from "./mergeResults";
import { partitionSnapshot } from "./partition";

describe("noneResult", () => {
  it("matches @scm/solver's own solveNone() shape exactly", () => {
    const real = solve({ nodes: [], edges: [] }, "none");
    expect(noneResult()).toEqual(real);
  });
});

describe("splitResultByComponents", () => {
  it("slices a combined multi-component solve() result back into one ComponentResult per component, by id membership", () => {
    const snapshot: SolverSnapshot = {
      nodes: [
        { id: "miner-1", recipe: "Iron Ore", machine: "Miner Mk.2", purity: "normal", limit: "30", limitMode: "ppm", clock: null, shards: 0 },
        { id: "smelter-1", recipe: "Iron Ingot", machine: "Smelter", purity: null, limit: null, limitMode: "machines", clock: null, shards: 0 },
        { id: "miner-2", recipe: "Iron Ore", machine: "Miner Mk.2", purity: "normal", limit: "60", limitMode: "ppm", clock: null, shards: 0 },
        { id: "smelter-2", recipe: "Iron Ingot", machine: "Smelter", purity: null, limit: null, limitMode: "machines", clock: null, shards: 0 },
      ],
      edges: [
        { id: "e1", part: "Iron Ore", fromNode: "miner-1", fromPort: "out", toNode: "smelter-1", toPort: "in" },
        { id: "e2", part: "Iron Ore", fromNode: "miner-2", fromPort: "out", toNode: "smelter-2", toPort: "in" },
      ],
    };
    const components = partitionSnapshot(snapshot);
    expect(components).toHaveLength(2);

    const combined = solve(snapshot, "basic", defaultGameData);
    const sliced = splitResultByComponents(combined, components);

    expect(sliced).toHaveLength(2);
    const component1 = sliced.find((c) => c.nodes.some((n) => n.nodeId === "miner-1"))!;
    const component2 = sliced.find((c) => c.nodes.some((n) => n.nodeId === "miner-2"))!;
    expect(component1.nodes.map((n) => n.nodeId).sort()).toEqual(["miner-1", "smelter-1"]);
    expect(component2.nodes.map((n) => n.nodeId).sort()).toEqual(["miner-2", "smelter-2"]);
    expect(component1.edges.map((e) => e.edgeId)).toEqual(["e1"]);
    expect(component2.edges.map((e) => e.edgeId)).toEqual(["e2"]);

    // Solving the components independently must give byte-identical
    // per-node results to solving them together — this is the correctness
    // argument for dirty-subgraph solving in the first place: disconnected
    // components can never influence each other's results.
    const independent1 = solve(components.find((c) => c.snapshot.nodes.some((n) => n.id === "miner-1"))!.snapshot, "basic", defaultGameData);
    expect(component1.nodes).toEqual(independent1.nodes);
  });
});

describe("mergeComponentResults", () => {
  it("reproduces a real solve() call's own .summary exactly, when merging that single call's own node results", () => {
    const snapshot: SolverSnapshot = {
      nodes: [
        { id: "miner-1", recipe: "Iron Ore", machine: "Miner Mk.2", purity: "normal", limit: "30", limitMode: "ppm", clock: null, shards: 0 },
        { id: "smelter-1", recipe: "Iron Ingot", machine: "Smelter", purity: null, limit: null, limitMode: "machines", clock: null, shards: 0 },
      ],
      edges: [{ id: "e1", part: "Iron Ore", fromNode: "miner-1", fromPort: "out", toNode: "smelter-1", toPort: "in" }],
    };
    const real = solve(snapshot, "basic", defaultGameData);
    const merged = mergeComponentResults("basic", [{ nodes: real.nodes, edges: real.edges }]);
    expect(merged.summary).toEqual(real.summary);
    expect(merged.valid).toBe(real.valid);
  });

  it("sums made/used additively across disjoint components and recomputes unmade/unused from the TOTAL, not by summing each component's own unmade/unused (the nonlinearity case)", () => {
    // Component A: a Miner making 30 Iron Ore/min with nothing consuming it
    // (all "unused"). Component B: a lone Smelter (no upstream miner)
    // wanting 30 Iron Ore/min it never gets (all "unmade"). Merged, made
    // and unmade/unused should reflect the TRUE combined balance (made=30,
    // used=30, unmade=0, unused=0) — summing each component's own unmade
    // (30) and unused (30) instead would wrongly report both as nonzero.
    const componentA: SolverSnapshot = {
      nodes: [{ id: "miner-a", recipe: "Iron Ore", machine: "Miner Mk.2", purity: "normal", limit: "30", limitMode: "ppm", clock: null, shards: 0 }],
      edges: [],
    };
    const componentB: SolverSnapshot = {
      nodes: [{ id: "smelter-b", recipe: "Iron Ingot", machine: "Smelter", purity: null, limit: "1", limitMode: "machines", clock: null, shards: 0 }],
      edges: [],
    };
    const resultA = solve(componentA, "basic", defaultGameData);
    const resultB = solve(componentB, "basic", defaultGameData);

    // Sanity: each component alone reports the lopsided balance described above.
    expect(resultA.summary.perPart["Iron Ore"]?.unused).not.toBe("0");
    expect(resultB.summary.perPart["Iron Ore"]?.unmade).not.toBe("0");

    const merged = mergeComponentResults("basic", [
      { nodes: resultA.nodes, edges: resultA.edges },
      { nodes: resultB.nodes, edges: resultB.edges },
    ]);

    // A Smelter at 1 machine, 100% clock, consumes exactly 30 Iron Ore/min —
    // matching the Miner's 30/min output exactly, so the TRUE merged
    // balance has nothing left over on either side.
    expect(merged.summary.perPart["Iron Ore"]).toEqual({ made: "30", used: "30", unmade: "0", unused: "0" });
  });

  it("valid is false if any merged node or edge is invalid", () => {
    const merged = mergeComponentResults("basic", [
      {
        nodes: [
          { nodeId: "a", machineCount: "1", clockPercent: "100", resolved: true, partRates: {}, power: 0, valid: true, issues: [] },
          { nodeId: "b", machineCount: "1", clockPercent: "100", resolved: false, partRates: {}, power: 0, valid: false, issues: ["bad"] },
        ],
        edges: [],
      },
    ]);
    expect(merged.valid).toBe(false);
    expect(merged.warnings).toContain("bad");
  });

  it("sorts merged nodes/edges by id regardless of input order (matching @scm/solver's own determinism guarantee)", () => {
    const merged = mergeComponentResults("basic", [
      {
        nodes: [
          { nodeId: "z", machineCount: "1", clockPercent: "100", resolved: true, partRates: {}, power: 0, valid: true, issues: [] },
          { nodeId: "a", machineCount: "1", clockPercent: "100", resolved: true, partRates: {}, power: 0, valid: true, issues: [] },
        ],
        edges: [],
      },
    ]);
    expect(merged.nodes.map((n) => n.nodeId)).toEqual(["a", "z"]);
  });
});
