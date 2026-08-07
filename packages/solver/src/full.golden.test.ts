// Hand-derived benchmark cases for Full mode's even-split-preference and
// two-tier-priority splitter/merger behavior — PLAN.md §8's Phase 6 exit
// criterion ("Full-mode results match the desktop tool on a shared
// benchmark set"). No real desktop Satisfactory Modeler reference data was
// obtainable in this environment (no network access, no bundled reference
// fixtures) — see jobs/023-full-calculator.md's Handoff notes, which flags
// this explicitly per the job's own acceptance-criteria wording. Every
// expected value below is instead hand-derived directly from PLAN.md's own
// rules ("flow divides equally among sibling output edges for the same
// part"; "top drains first, bottom takes overflow") using small graphs
// simple enough to verify by arithmetic, the same style Job 017's
// `golden.test.ts` used for Basic mode.
//
// Every producer in these graphs uses `limitMode: "ppm"` so its entered
// limit IS its exact per-minute output rate directly (no need to reason
// about a specific machine's base rate) — every consumer's expected output
// is then checked against a Smelter's real, game-data-derived 1:1
// Iron-Ore-in : Iron-Ingot-out ratio at 30/min/machine (verified already by
// Job 017's own golden test), so machine counts below are genuine
// `machineCountForTargetRate` results, not just restated input numbers.
import { equals, of, parseRational } from "@scm/rational";
import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverEdge, SolverNode, SolverSnapshot } from "./snapshot";

function miner(id: string, ppm: string): SolverNode {
  return { id, recipe: "Iron Ore", machine: "Miner Mk.1", purity: "normal", limit: ppm, limitMode: "ppm", clock: null, shards: 0 };
}

function unconstrainedSmelter(id: string): SolverNode {
  return { id, recipe: "Iron Ingot", machine: "Smelter", purity: null, limit: null, limitMode: "machines", clock: null, shards: 0 };
}

function pinnedSmelter(id: string, ingotPpm: string): SolverNode {
  // Iron Ingot is Smelter's primary (output) part, so a "ppm" limit anchors
  // to it directly — 1:1 recipe means this also fixes Iron Ore demand at
  // the same magnitude.
  return { id, recipe: "Iron Ingot", machine: "Smelter", purity: null, limit: ingotPpm, limitMode: "ppm", clock: null, shards: 0 };
}

function edge(id: string, from: string, to: string, priorityTier?: "top" | "bottom"): SolverEdge {
  return { id, part: "Iron Ore", fromNode: from, fromPort: "out", toNode: to, toPort: "in", ...(priorityTier ? { priorityTier } : {}) };
}

function ingotRate(result: ReturnType<typeof solveFull>, nodeId: string): ReturnType<typeof parseRational> {
  const node = result.nodes.find((n) => n.nodeId === nodeId);
  if (!node) throw new Error(`node "${nodeId}" missing from result`);
  return parseRational(node.partRates["Iron Ingot"] ?? "0");
}

function solveFull(snapshot: SolverSnapshot) {
  return solve(snapshot, "full", defaultGameData);
}

describe("Full mode golden values — even-split preference (hand-derived from PLAN.md's Full row)", () => {
  it("splits evenly three ways with no downstream constraint: 60/min -> 20/20/20", () => {
    const nodes = [miner("producer", "60"), unconstrainedSmelter("a"), unconstrainedSmelter("b"), unconstrainedSmelter("c")];
    const edges = [edge("e-a", "producer", "a"), edge("e-b", "producer", "b"), edge("e-c", "producer", "c")];
    const result = solveFull({ nodes, edges });

    expect(result.valid).toBe(true);
    for (const id of ["a", "b", "c"]) {
      // 20 Iron Ore/min in -> 20 Iron Ingot/min out (1:1 recipe).
      expect(equals(ingotRate(result, id), of(20))).toBe(true);
    }
    // 20/min at 30/min-per-machine = 2/3 machine each.
    const a = result.nodes.find((n) => n.nodeId === "a")!;
    expect(equals(parseRational(a.machineCount), of(2, 3))).toBe(true);
    expect(a.resolved).toBe(true);
  });

  it("redistributes the remainder when one sibling's own demand caps its share below the equal split: 90/min -> 10/40/40", () => {
    // Smelter "a" is pinned to a hard 10/min Iron Ingot demand (a real
    // capacity constraint, not just an even-split default); "b"/"c" are
    // unconstrained. Water-filling: round 1 equal share = 30 each, but
    // "a"'s cap (10) is below that, so it saturates at exactly 10; the
    // remaining 80 splits evenly between "b" and "c" (40 each).
    const nodes = [miner("producer", "90"), pinnedSmelter("a", "10"), unconstrainedSmelter("b"), unconstrainedSmelter("c")];
    const edges = [edge("e-a", "producer", "a"), edge("e-b", "producer", "b"), edge("e-c", "producer", "c")];
    const result = solveFull({ nodes, edges });

    expect(result.valid).toBe(true);
    expect(equals(ingotRate(result, "a"), of(10))).toBe(true);
    expect(equals(ingotRate(result, "b"), of(40))).toBe(true);
    expect(equals(ingotRate(result, "c"), of(40))).toBe(true);

    const edgeA = result.edges.find((e) => e.edgeId === "e-a")!;
    expect(equals(parseRational(edgeA.rate), of(10))).toBe(true);
    expect(edgeA.valid).toBe(true);
  });

  it("produces an even split regardless of node/edge array order (sanity check before the dedicated determinism suite)", () => {
    const nodes = [miner("producer", "90"), pinnedSmelter("a", "10"), unconstrainedSmelter("b"), unconstrainedSmelter("c")];
    const edges = [edge("e-a", "producer", "a"), edge("e-b", "producer", "b"), edge("e-c", "producer", "c")];
    const forward = solveFull({ nodes, edges });
    const reversed = solveFull({ nodes: [...nodes].reverse(), edges: [...edges].reverse() });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});

describe("Full mode golden values — two-tier priority (hand-derived: \"top drains first, bottom takes overflow\")", () => {
  it("an uncapped top-tier sibling absorbs everything; the bottom-tier sibling gets exactly zero", () => {
    // "bottom-a" is pinned to exactly 0 machines (a real, valid, explicit
    // "this consumer isn't running" pin — NOT left unconstrained) so its
    // own cap is a hard, known ZERO from the start, rather than exercising
    // Basic mode's separate "unresolved -> defaults to 1 machine" fallback
    // path, which is a different mechanism this test isn't about.
    const zeroMachineSmelter: SolverNode = {
      id: "bottom-a",
      recipe: "Iron Ingot",
      machine: "Smelter",
      purity: null,
      limit: "0",
      limitMode: "machines",
      clock: null,
      shards: 0,
    };
    const nodes = [miner("producer", "90"), unconstrainedSmelter("top-a"), unconstrainedSmelter("top-b"), zeroMachineSmelter];
    const edges = [
      edge("e-top-a", "producer", "top-a", "top"),
      edge("e-top-b", "producer", "top-b", "top"),
      edge("e-bottom-a", "producer", "bottom-a", "bottom"),
    ];
    const result = solveFull({ nodes, edges });

    expect(result.valid).toBe(true);
    // Top tier is uncapped, so it drains the full 90/min evenly (45 each);
    // bottom gets literally nothing — both at the edge level AND at
    // "bottom-a"'s own (pinned-at-zero, not defaulted) machine count.
    expect(equals(ingotRate(result, "top-a"), of(45))).toBe(true);
    expect(equals(ingotRate(result, "top-b"), of(45))).toBe(true);
    expect(equals(ingotRate(result, "bottom-a"), of(0))).toBe(true);

    const bottomNode = result.nodes.find((n) => n.nodeId === "bottom-a")!;
    expect(bottomNode.resolved).toBe(true);
    expect(equals(parseRational(bottomNode.machineCount), of(0))).toBe(true);

    const bottomEdge = result.edges.find((e) => e.edgeId === "e-bottom-a")!;
    expect(equals(parseRational(bottomEdge.rate), of(0))).toBe(true);
    expect(bottomEdge.valid).toBe(true);
  });

  it("a capped top-tier sibling only takes its own demand; the overflow flows entirely to the bottom tier", () => {
    // Top tier: Smelter "top-a" pinned to a hard 20/min demand. Bottom
    // tier: Smelter "bottom-a" unconstrained. Top drains first (gets
    // exactly its 20/min cap, not less), and the remaining 40/min of the
    // producer's 60/min overflows entirely to the bottom tier.
    const nodes = [miner("producer", "60"), pinnedSmelter("top-a", "20"), unconstrainedSmelter("bottom-a")];
    const edges = [edge("e-top-a", "producer", "top-a", "top"), edge("e-bottom-a", "producer", "bottom-a", "bottom")];
    const result = solveFull({ nodes, edges });

    expect(result.valid).toBe(true);
    expect(equals(ingotRate(result, "top-a"), of(20))).toBe(true);
    expect(equals(ingotRate(result, "bottom-a"), of(40))).toBe(true);
  });

  it("priority also governs the MERGE direction: a top-tier supplier drains fully before a bottom-tier supplier contributes anything", () => {
    // A single pinned consumer demands exactly 50 Iron Ore/min, drawing
    // from two unconstrained producers — one tagged "top", one "bottom" on
    // its own supplying edge. The top-tier supplier is uncapped (an
    // unconstrained producer can supply any amount), so it alone satisfies
    // the full 50/min demand; the bottom-tier supplier gets zero implied
    // demand and stays unresolved.
    const consumer: SolverNode = {
      id: "consumer",
      recipe: "Iron Ingot",
      machine: "Smelter",
      purity: null,
      limit: "50",
      limitMode: "ppm",
      clock: null,
      shards: 0,
    };
    const nodes = [consumer, miner("top-supplier", "1"), miner("bottom-supplier", "1")];
    // Both suppliers' OWN limits are irrelevant to the merge — they're
    // unconstrained from the consumer's perspective in the sense that
    // matters here: what matters is whether propagation can infer a NEW
    // machine count for them (it currently just pins them at "1" via ppm;
    // to exercise real inference, leave them unpinned instead).
    nodes[1] = { ...nodes[1]!, limit: null, limitMode: "machines" };
    nodes[2] = { ...nodes[2]!, limit: null, limitMode: "machines" };
    const edges = [
      edge("e-top", "top-supplier", "consumer", "top"),
      edge("e-bottom", "bottom-supplier", "consumer", "bottom"),
    ];
    const result = solveFull({ nodes, edges });

    const topRate = parseRational(result.nodes.find((n) => n.nodeId === "top-supplier")!.partRates["Iron Ore"]!);
    const bottomNode = result.nodes.find((n) => n.nodeId === "bottom-supplier")!;
    expect(equals(topRate, of(50))).toBe(true);
    expect(bottomNode.resolved).toBe(false);
    expect(equals(parseRational(bottomNode.machineCount), of(1))).toBe(true);
  });
});
