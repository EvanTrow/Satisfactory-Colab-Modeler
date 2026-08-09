// Integration regression test for the "byproduct reuse" topology bug found
// while investigating why Generate Factory's Water byproducts kept showing
// "Rate mismatch"/"Not enough input" even with the generator's own bugs
// fixed: two INDEPENDENT producers both wired into the SAME two consumers
// (a byproduct source plus the raw producer it's offsetting, feeding every
// consumer the raw producer already had — see the web app's
// `applyByproductReuse`) is exactly "two splitter/merger points adjacent on
// the same part," the documented scope limitation in `full.ts`'s own header
// that `jointFlow.ts`/`edgeResolution.ts` now resolve. This test reproduces
// the minimal shape through the real `solve()` entry point for both Basic
// and Full mode, with a synthetic 1:1-ratio game-data fixture so the
// expected numbers are exact and easy to verify by hand.
import { loadGameData } from "@scm/gamedata";
import { add, equals, of, parseRational } from "@scm/rational";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverSnapshot } from "./snapshot";

const gameData = loadGameData({
  Machines: [{ Name: "Constructor", Tier: "0-0" }],
  MultiMachines: [],
  Parts: [
    { Name: "RawSource", Tier: "0-0", SinkPoints: 0 },
    { Name: "SharedPart", Tier: "0-0", SinkPoints: 0 },
    { Name: "Output1", Tier: "0-0", SinkPoints: 0 },
  ],
  Recipes: [
    // primaryPart = SharedPart (its only positive-amount entry) — a "ppm"
    // limit anchors directly to it, so each producer node's SharedPart
    // output rate is exactly the limit value, no machine-count rounding.
    {
      Name: "MakeShared",
      Machine: "Constructor",
      BatchTime: "60",
      Tier: "0-0",
      Parts: [{ Part: "RawSource", Amount: "-2" }, { Part: "SharedPart", Amount: "1" }],
    },
    // 1:1 SharedPart-in : Output1-out ratio, so a "ppm" limit on Output1
    // (its own primaryPart) is numerically identical to its SharedPart
    // consumption rate — same convenience for the consumer side.
    {
      Name: "UseShared",
      Machine: "Constructor",
      BatchTime: "60",
      Tier: "0-0",
      Parts: [{ Part: "SharedPart", Amount: "-1" }, { Part: "Output1", Amount: "1" }],
    },
  ],
});

// Two producers (16 + 9 = 25/min SharedPart total), two consumers (5 + 20 =
// 25/min total) — balanced overall, but asymmetric: neither producer's
// output matches either consumer's demand, so any naive per-node-
// independent even split (the pre-fix behavior) mis-divides it. Every
// producer wired to every consumer, matching `applyByproductReuse`'s own
// "feed every one of the raw producer's existing consumers" fan-out.
function diamondSnapshot(): SolverSnapshot {
  return {
    nodes: [
      { id: "producer1", recipe: "MakeShared", machine: "Constructor", purity: null, limit: "16", limitMode: "ppm", clock: null, shards: 0 },
      { id: "producer2", recipe: "MakeShared", machine: "Constructor", purity: null, limit: "9", limitMode: "ppm", clock: null, shards: 0 },
      { id: "consumer1", recipe: "UseShared", machine: "Constructor", purity: null, limit: "5", limitMode: "ppm", clock: null, shards: 0 },
      { id: "consumer2", recipe: "UseShared", machine: "Constructor", purity: null, limit: "20", limitMode: "ppm", clock: null, shards: 0 },
    ],
    edges: [
      { id: "p1-c1", part: "SharedPart", fromNode: "producer1", fromPort: "out:SharedPart", toNode: "consumer1", toPort: "in:SharedPart" },
      { id: "p1-c2", part: "SharedPart", fromNode: "producer1", fromPort: "out:SharedPart", toNode: "consumer2", toPort: "in:SharedPart" },
      { id: "p2-c1", part: "SharedPart", fromNode: "producer2", fromPort: "out:SharedPart", toNode: "consumer1", toPort: "in:SharedPart" },
      { id: "p2-c2", part: "SharedPart", fromNode: "producer2", fromPort: "out:SharedPart", toNode: "consumer2", toPort: "in:SharedPart" },
    ],
  };
}

describe.each(["basic", "full"] as const)("byproduct-reuse-shaped diamond (%s mode)", (mode) => {
  it("balances exactly with no rate-mismatch/shortfall false positive, and each side's total matches its own declared rate", () => {
    const result = solve(diamondSnapshot(), mode, gameData);

    expect(result.valid).toBe(true);
    for (const edge of result.edges) {
      expect(edge.valid).toBe(true);
      expect(edge.issues).toEqual([]);
    }

    const rate = (id: string) => parseRational(result.edges.find((e) => e.edgeId === id)!.rate);
    // The exact per-edge split isn't unique (see `jointFlow.test.ts`'s own
    // "reported byproduct-reuse bug" case for the specific numbers this
    // algorithm actually picks) — what's load-bearing here is that every
    // consumer's TWO incoming edges sum to exactly its own declared demand,
    // and every producer's two outgoing edges sum to exactly its own
    // declared supply. A naive per-node-independent even split (the
    // pre-fix behavior) cannot satisfy this for these numbers, since no
    // producer's output matches either consumer's demand.
    expect(equals(add(rate("p1-c1"), rate("p2-c1")), of(5))).toBe(true); // consumer1's declared demand
    expect(equals(add(rate("p1-c2"), rate("p2-c2")), of(20))).toBe(true); // consumer2's declared demand
    expect(equals(add(rate("p1-c1"), rate("p1-c2")), of(16))).toBe(true); // producer1's declared supply
    expect(equals(add(rate("p2-c1"), rate("p2-c2")), of(9))).toBe(true); // producer2's declared supply
  });
});
