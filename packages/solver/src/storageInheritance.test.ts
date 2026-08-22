// `SolverNode.capMachineCountAtNodeId` (see `snapshot.ts`'s own doc
// comment) — the fix for `apps/web/src/workers/storagePassthrough.ts`'s
// Storage Container rewrite, whose intake and outflow sides are two
// separate synthetic `blueprintCopyBasis` nodes with NO solver edge between
// them. Without this field, the outflow side could only ever resolve its
// machine count from a REAL downstream neighbor's own pin — anything else
// (nothing downstream pinned at all) fell all the way through to Basic/Full
// mode's flat `ONE`-machine default, regardless of how much the intake side
// was actually receiving; and once something WAS pinned downstream, the
// outflow side would happily report whatever downstream demanded even past
// what the intake side actually received (a physically-impossible "emit
// more than you take in"). These tests exercise the fix directly at the
// `@scm/solver` level, using plain snapshots shaped exactly like
// `storagePassthrough.ts`'s own rewrite (a `limit: null` "consumer" node
// with `perCopyRates: { [part]: "-1" }` and a `limit: null` "producer" node
// with `perCopyRates: { [part]: "1" }`, the producer's
// `capMachineCountAtNodeId` pointing at the consumer) rather than going
// through `apps/web` at all — this package has no dependency on it.
import { equals, of, parseRational } from "@scm/rational";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverMode, SolverSnapshot } from "./snapshot";

/** A pinned Miner (real recipe node) feeding a storage-shaped synthetic consumer/producer pair, feeding a downstream Smelter — mirrors `storagePassthrough.ts`'s own rewrite shape for one part. `smelterPpm` (a `"ppm"`-mode limit, `null` for unpinned) lets a test control the downstream side's own demand precisely. */
function buildSnapshot(minerPpm: string, smelterPpm: string | null): SolverSnapshot {
  return {
    nodes: [
      {
        id: "miner",
        recipe: "Iron Ore",
        machine: "Miner Mk.1",
        purity: "normal",
        limit: minerPpm,
        limitMode: "ppm",
        clock: null,
        shards: 0,
      },
      {
        id: "stg-in",
        recipe: "",
        machine: "",
        purity: null,
        limit: null,
        limitMode: "ppm",
        clock: null,
        shards: 0,
        blueprintCopyBasis: { perCopyRates: { "Iron Ore": "-1" }, perCopyPowerMW: 0 },
      },
      {
        id: "stg-out",
        recipe: "",
        machine: "",
        purity: null,
        limit: null,
        limitMode: "ppm",
        clock: null,
        shards: 0,
        blueprintCopyBasis: { perCopyRates: { "Iron Ore": "1" }, perCopyPowerMW: 0 },
        capMachineCountAtNodeId: "stg-in",
      },
      {
        id: "smelter",
        recipe: "Iron Ingot",
        machine: "Smelter",
        purity: null,
        limit: smelterPpm,
        limitMode: "ppm",
        clock: null,
        shards: 0,
      },
    ],
    edges: [
      { id: "e1", part: "Iron Ore", fromNode: "miner", fromPort: "out", toNode: "stg-in", toPort: "in" },
      { id: "e2", part: "Iron Ore", fromNode: "stg-out", fromPort: "out", toNode: "smelter", toPort: "in" },
    ],
  };
}

describe.each<SolverMode>(["basic", "full"])("Storage Container output capping (%s mode)", (mode) => {
  it("an unpinned downstream node gets the real intake-derived rate, not the flat 1-machine default", () => {
    const snapshot = buildSnapshot("30", null);
    const result = solve(snapshot, mode);

    const producer = result.nodes.find((n) => n.nodeId === "stg-out")!;
    expect(producer.resolved).toBe(true);
    expect(equals(parseRational(producer.partRates["Iron Ore"]!), of(30))).toBe(true);

    const smelter = result.nodes.find((n) => n.nodeId === "smelter")!;
    expect(smelter.resolved).toBe(true);
    expect(equals(parseRational(smelter.partRates["Iron Ingot"]!), of(30))).toBe(true);

    const edge = result.edges.find((e) => e.edgeId === "e2")!;
    expect(edge.valid).toBe(true);
  });

  it("a downstream demand BELOW the intake supply passes through untouched, no mismatch", () => {
    const snapshot = buildSnapshot("120", "20");
    const result = solve(snapshot, mode);

    const producer = result.nodes.find((n) => n.nodeId === "stg-out")!;
    expect(equals(parseRational(producer.partRates["Iron Ore"]!), of(20))).toBe(true);

    const edge = result.edges.find((e) => e.edgeId === "e2")!;
    expect(edge.valid).toBe(true);
    expect(equals(parseRational(edge.rate), of(20))).toBe(true);
  });

  it("a downstream demand ABOVE the intake supply is capped at the intake's rate, and the edge is flagged mismatched — cannot output more than was received", () => {
    // Reproduces the reported bug: 120/min in, downstream (Cable
    // Constructor equivalent) pinned to want 180/min. The output must cap
    // at 120 — it can never emit more than it took in — and the downstream
    // node's own shortfall must be visible via the ordinary edge-mismatch
    // signal, exactly like it would be for two ordinary mismatched pinned
    // recipe nodes.
    const snapshot = buildSnapshot("120", "180");
    const result = solve(snapshot, mode);

    const producer = result.nodes.find((n) => n.nodeId === "stg-out")!;
    expect(producer.resolved).toBe(true);
    expect(equals(parseRational(producer.partRates["Iron Ore"]!), of(120))).toBe(true);

    // The downstream node's OWN resolved demand still reflects what it
    // asked for (its own pin) — the shortfall shows up on the EDGE, not by
    // silently shrinking the downstream node's own numbers.
    const smelter = result.nodes.find((n) => n.nodeId === "smelter")!;
    expect(equals(parseRational(smelter.partRates["Iron Ingot"]!), of(180))).toBe(true);

    const edge = result.edges.find((e) => e.edgeId === "e2")!;
    expect(edge.valid).toBe(false);
  });

  it("with nothing feeding the intake side either, both synthetic sides still fall back to the documented 1-machine default", () => {
    const snapshot = buildSnapshot("30", null);
    // Drop the miner->intake edge entirely, so the intake side itself has
    // nothing to resolve from — there's no cap to inherit.
    const disconnected: SolverSnapshot = { ...snapshot, edges: snapshot.edges.slice(1) };
    const result = solve(disconnected, mode);

    const consumer = result.nodes.find((n) => n.nodeId === "stg-in")!;
    expect(consumer.resolved).toBe(false);

    const producer = result.nodes.find((n) => n.nodeId === "stg-out")!;
    expect(producer.resolved).toBe(false);
    expect(equals(parseRational(producer.partRates["Iron Ore"]!), of(1))).toBe(true);
  });
});
