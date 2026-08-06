// The four golden-value tests PLAN.md §9 names explicitly ("Solver golden
// values"): "assert against known-correct Satisfactory ratios computed by
// hand from `game_data.json` ... These are the tests that prove we read the
// data model correctly." Every rate assertion uses exact `Rational`
// equality (`equals`/`of`), never a float/string comparison — per this
// job's own acceptance criteria ("using Rational equality, not float
// approximation, for anything that isn't power").
import { equals, of, parseRational } from "@scm/rational";
import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverSnapshot } from "./snapshot";

function rate(snapshot: SolverSnapshot, nodeId: string, part: string) {
  const result = solve(snapshot, "basic", defaultGameData);
  const node = result.nodes.find((n) => n.nodeId === nodeId);
  if (!node) throw new Error(`node "${nodeId}" missing from solve result`);
  return { result, node, rate: parseRational(node.partRates[part] ?? "0") };
}

describe("golden values (PLAN.md §9)", () => {
  it("30 Iron Ore/min -> 30 Iron Ingot/min", () => {
    // A Miner Mk.1 on Normal purity, limited to exactly 30 Iron Ore/min,
    // feeding a Smelter with NO limit of its own — Basic mode must infer
    // the Smelter's machine count from the incoming edge (graph
    // propagation, not just per-node math), and since "Iron Ingot"'s
    // recipe is 1-Iron-Ore-in : 1-Iron-Ingot-out, the output rate must come
    // out at exactly 30/min too.
    const snapshot: SolverSnapshot = {
      nodes: [
        {
          id: "miner",
          recipe: "Iron Ore",
          machine: "Miner Mk.1",
          purity: "normal",
          limit: "30",
          limitMode: "ppm",
          clock: null,
          shards: 0,
        },
        {
          id: "smelter",
          recipe: "Iron Ingot",
          machine: "Smelter",
          purity: null,
          limit: null,
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
      ],
      edges: [
        {
          id: "edge-1",
          part: "Iron Ore",
          fromNode: "miner",
          fromPort: "out",
          toNode: "smelter",
          toPort: "in",
        },
      ],
    };

    const minerOre = rate(snapshot, "miner", "Iron Ore");
    expect(equals(minerOre.rate, of(30))).toBe(true);

    const smelterOreIn = rate(snapshot, "smelter", "Iron Ore");
    expect(equals(smelterOreIn.rate, of(-30))).toBe(true);

    const smelterIngotOut = rate(snapshot, "smelter", "Iron Ingot");
    expect(equals(smelterIngotOut.rate, of(30))).toBe(true);
    expect(smelterIngotOut.node.resolved).toBe(true);
    expect(smelterIngotOut.result.valid).toBe(true);

    const edge = smelterIngotOut.result.edges.find((e) => e.edgeId === "edge-1");
    expect(edge?.valid).toBe(true);
    expect(equals(parseRational(edge!.rate), of(30))).toBe(true);
  });

  it("Miner Mk.3 on a Pure node = 480/min", () => {
    const snapshot: SolverSnapshot = {
      nodes: [
        {
          id: "miner",
          recipe: "Iron Ore",
          machine: "Miner Mk.3",
          purity: "pure",
          limit: "1",
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
      ],
      edges: [],
    };

    const { rate: oreRate } = rate(snapshot, "miner", "Iron Ore");
    expect(equals(oreRate, of(480))).toBe(true);
  });

  it("Manufacturer with 4 somersloops = 2x output at 4x power", () => {
    const baseline: SolverSnapshot = {
      nodes: [
        {
          id: "manufacturer",
          recipe: "Plastic Smart Plating",
          machine: "Manufacturer",
          purity: null,
          limit: "1",
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
      ],
      edges: [],
    };
    const boosted: SolverSnapshot = {
      nodes: [{ ...baseline.nodes[0]!, shards: 4 }],
      edges: [],
    };

    const baseResult = solve(baseline, "basic", defaultGameData);
    const boostedResult = solve(boosted, "basic", defaultGameData);
    const baseNode = baseResult.nodes[0]!;
    const boostedNode = boostedResult.nodes[0]!;

    const baseOutput = parseRational(baseNode.partRates["Smart Plating"]!);
    const boostedOutput = parseRational(boostedNode.partRates["Smart Plating"]!);
    expect(equals(boostedOutput, of(10))).toBe(true); // 5/min at 1x -> 10/min at 2x
    expect(equals(baseOutput, of(5))).toBe(true);

    // Inputs are NOT boosted by somersloops (production amplification, not
    // free extra input) — see nodeProfile.ts's `partRateAtMachineCount`.
    const baseInput = parseRational(baseNode.partRates["Plastic"]!);
    const boostedInput = parseRational(boostedNode.partRates["Plastic"]!);
    expect(equals(baseInput, boostedInput)).toBe(true);

    expect(boostedNode.power).toBeCloseTo(baseNode.power * 4, 10);
    expect(baseNode.power).toBeCloseTo(-55, 10);
    expect(boostedNode.power).toBeCloseTo(-220, 10);
  });

  it("a Coal Generator chain's water draw", () => {
    // 2 Coal-Powered Generators running "Coal Generator" (fuel-in,
    // power-out; a generator recipe with no positive-amount part) at 100%
    // clock: -3 Water / 4s per machine = -45/min per machine = -90/min for
    // 2, and +75 MW per machine = +150 MW generated for 2.
    const snapshot: SolverSnapshot = {
      nodes: [
        {
          id: "coal-gen",
          recipe: "Coal Generator",
          machine: "Coal-Powered Generator",
          purity: null,
          limit: "2",
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
      ],
      edges: [],
    };

    const result = solve(snapshot, "basic", defaultGameData);
    const node = result.nodes[0]!;
    expect(equals(parseRational(node.partRates.Water!), of(-90))).toBe(true);
    expect(equals(parseRational(node.partRates.Coal!), of(-30))).toBe(true);
    expect(node.power).toBeCloseTo(150, 10);
  });
});
