// Manual mode: PLAN.md §2's table — entered values are final, so the only
// thing to test is (a) it reports exactly the entered/derived values with
// no inference, and (b) edge validation catches a genuine mismatch.
import { defaultGameData } from "@scm/gamedata";
import { equals, of, parseRational } from "@scm/rational";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverSnapshot } from "./snapshot";

describe("Manual mode", () => {
  it("reports each node's own entered values with no cross-node inference", () => {
    const snapshot: SolverSnapshot = {
      nodes: [
        {
          id: "smelter",
          recipe: "Iron Ingot",
          machine: "Smelter",
          purity: null,
          limit: "3",
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
        {
          id: "idle-constructor",
          // A downstream node with NO limit — Manual mode must default it
          // to exactly 1 machine (the spreadsheet-like "final value"
          // convention), never infer anything from the (nonexistent) edge.
          recipe: "Iron Rod",
          machine: "Constructor",
          purity: null,
          limit: null,
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
      ],
      edges: [],
    };

    const result = solve(snapshot, "manual", defaultGameData);
    const smelter = result.nodes.find((n) => n.nodeId === "smelter")!;
    const idle = result.nodes.find((n) => n.nodeId === "idle-constructor")!;

    expect(equals(parseRational(smelter.machineCount), of(3))).toBe(true);
    expect(equals(parseRational(smelter.partRates["Iron Ingot"]!), of(90))).toBe(true);
    expect(equals(parseRational(idle.machineCount), of(1))).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("flags an edge whose two ends disagree on rate as invalid, with the mismatch reported", () => {
    // Miner set to 60/min, feeding a Smelter EXPLICITLY set to only 2
    // machines (60/min worth) at 50% clock -- entered rate is only 30/min
    // -- an inconsistent user entry Manual mode must catch, not silently
    // average away.
    const snapshot: SolverSnapshot = {
      nodes: [
        {
          id: "miner",
          recipe: "Iron Ore",
          machine: "Miner Mk.1",
          purity: "normal",
          limit: "60",
          limitMode: "ppm",
          clock: null,
          shards: 0,
        },
        {
          id: "smelter",
          recipe: "Iron Ingot",
          machine: "Smelter",
          purity: null,
          limit: "2",
          limitMode: "machines",
          clock: "50",
          shards: 0,
        },
      ],
      edges: [
        { id: "e-1", part: "Iron Ore", fromNode: "miner", fromPort: "out", toNode: "smelter", toPort: "in" },
      ],
    };

    const result = solve(snapshot, "manual", defaultGameData);
    expect(result.valid).toBe(false);
    const edge = result.edges.find((e) => e.edgeId === "e-1")!;
    expect(edge.valid).toBe(false);
    expect(edge.issues.length).toBeGreaterThan(0);
    expect(edge.issues[0]).toMatch(/rate mismatch/);
  });

  it("validates a consistent even-split fan-out as valid", () => {
    const snapshot: SolverSnapshot = {
      nodes: [
        {
          id: "miner",
          recipe: "Iron Ore",
          machine: "Miner Mk.1",
          purity: "normal",
          limit: "60",
          limitMode: "ppm",
          clock: null,
          shards: 0,
        },
        {
          id: "smelter-a",
          recipe: "Iron Ingot",
          machine: "Smelter",
          purity: null,
          limit: "1",
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
        {
          id: "smelter-b",
          recipe: "Iron Ingot",
          machine: "Smelter",
          purity: null,
          limit: "1",
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
      ],
      edges: [
        { id: "e-1", part: "Iron Ore", fromNode: "miner", fromPort: "out", toNode: "smelter-a", toPort: "in" },
        { id: "e-2", part: "Iron Ore", fromNode: "miner", fromPort: "out", toNode: "smelter-b", toPort: "in" },
      ],
    };

    const result = solve(snapshot, "manual", defaultGameData);
    // Each Smelter at 1 machine wants 30/min; the Miner's 60/min splits
    // evenly two ways into exactly 30/min per edge -- consistent.
    expect(result.valid).toBe(true);
    for (const edge of result.edges) {
      expect(edge.valid).toBe(true);
    }
  });
});
