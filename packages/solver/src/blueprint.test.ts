// Job 026 (Blueprints, PLAN.md §10.3): proves the chosen copy-count
// semantics — a blueprint's copy count is represented as an ordinary
// `SolverNode` (`blueprintCopyBasis` set) whose "machine count" IS the copy
// count, participating in the EXACT SAME fixed-point propagation
// (`basic.ts`/`full.ts`) as every real recipe node, with zero changes to
// either of those modules. See jobs/026-blueprints.md's Handoff notes ("How
// PLAN.md §10.3 was resolved") for the full write-up this test file backs.
//
// The external "boundary" nodes below are real `@scm/gamedata` recipes
// (Reinforced Iron Plate on an Assembler: 12s batch, -6 Iron Plate / -12
// Screw / +1 Reinforced Iron Plate per batch -> -30 / -60 / +5 per minute at
// one machine, 100% clock) — the same "mix hand-derived expectations with
// real recipe data" style `golden.test.ts`/`full.golden.test.ts` already
// established, so this exercises the REAL `nodeProfile.ts` resolution path
// on the non-compound side of every edge, not just two synthetic profiles
// talking to each other.
import { equals, of, parseRational } from "@scm/rational";
import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverEdge, SolverNode, SolverSnapshot } from "./snapshot";

/** A blueprint compound node producing/consuming `perCopyRates` at exactly 1 copy. `limit`/`limitMode` default to unpinned (the normal case — copies is a SOLVED value); pass them to simulate a `Container.copiesLimit` hard pin. */
function blueprintNode(
  id: string,
  perCopyRates: Record<string, string>,
  options: { perCopyPowerMW?: number; limit?: string | null; limitMode?: "machines" | "ppm" } = {},
): SolverNode {
  return {
    id,
    recipe: "",
    machine: "",
    purity: null,
    limit: options.limit ?? null,
    limitMode: options.limitMode ?? "machines",
    clock: null,
    shards: 0,
    blueprintCopyBasis: { perCopyRates, perCopyPowerMW: options.perCopyPowerMW ?? 0 },
  };
}

function reinforcedIronPlateAssembler(id: string, limit: string | null, limitMode: "machines" | "ppm" = "machines"): SolverNode {
  return { id, recipe: "Reinforced Iron Plate", machine: "Assembler", purity: null, limit, limitMode, clock: null, shards: 0 };
}

function edge(id: string, part: string, from: string, to: string, priorityTier?: "top" | "bottom"): SolverEdge {
  return { id, part, fromNode: from, fromPort: "out", toNode: to, toPort: "in", ...(priorityTier ? { priorityTier } : {}) };
}

describe("Blueprint compound node — copy count as a solved joint-solve variable (PLAN.md §10.3)", () => {
  it("Basic mode: copies is INFERRED from external demand, not a post-multiply — 3 assemblers pull exactly 6 copies", () => {
    // 1 copy of the blueprint produces 15 Iron Plate/min. An Assembler
    // pinned to exactly 3 machines demands 3 * 30 = 90 Iron Plate/min. For
    // the boundary edge to balance, the blueprint needs 90 / 15 = 6 copies
    // — and Basic mode's ORDINARY propagation (the same
    // `machineCountForTargetRate` call any unpinned recipe node goes
    // through) is what has to derive that 6, from nothing but the resolved
    // neighbor's demand crossing the one boundary edge.
    const bp = blueprintNode("bp", { "Iron Plate": "15" }, { perCopyPowerMW: -10 });
    const assembler = reinforcedIronPlateAssembler("assembler", "3");
    const snapshot: SolverSnapshot = {
      nodes: [bp, assembler],
      edges: [edge("e1", "Iron Plate", "bp", "assembler")],
    };

    const result = solve(snapshot, "basic", defaultGameData);
    expect(result.valid).toBe(true);

    const bpResult = result.nodes.find((n) => n.nodeId === "bp")!;
    expect(bpResult.resolved).toBe(true);
    expect(equals(parseRational(bpResult.machineCount), of(6))).toBe(true); // the copy count
    expect(equals(parseRational(bpResult.partRates["Iron Plate"]!), of(90))).toBe(true);
    // Power scales with copies too — -10 MW/copy * 6 copies.
    expect(bpResult.power).toBeCloseTo(-60, 10);

    const edgeResult = result.edges.find((e) => e.edgeId === "e1")!;
    expect(edgeResult.valid).toBe(true);
    expect(equals(parseRational(edgeResult.rate), of(90))).toBe(true);

    const assemblerResult = result.nodes.find((n) => n.nodeId === "assembler")!;
    expect(equals(parseRational(assemblerResult.partRates["Iron Plate"]!), of(-90))).toBe(true);
  });

  it("Basic mode: a blueprint with no boundary connection at all defaults to exactly 1 copy, unresolved — same fallback every ordinary node already has", () => {
    const bp = blueprintNode("bp", { "Iron Plate": "15" });
    const result = solve({ nodes: [bp], edges: [] }, "basic", defaultGameData);
    const bpResult = result.nodes.find((n) => n.nodeId === "bp")!;
    expect(bpResult.resolved).toBe(false);
    expect(equals(parseRational(bpResult.machineCount), of(1))).toBe(true);
    expect(bpResult.valid).toBe(true); // "unresolved, defaulted" is a warning, not an error — matches basic.ts's own convention.
  });

  it("Full mode: a hard-pinned copy count (Container.copiesLimit's encoding) still respects priority tiers across its OWN boundary edges exactly like a real node's siblings would", () => {
    // bp is PINNED to exactly 3 copies (simulating `copiesLimit`) -> 3 * 10
    // = 30 Iron Plate/min total. Top tier demands exactly 20/min (a 2/3-
    // machine Assembler pin); bottom tier is a genuinely unconstrained
    // Assembler that must resolve to whatever overflow is left (10/min),
    // via ordinary propagation — not a fallback default.
    const bp = blueprintNode("bp", { "Iron Plate": "10" }, { limit: "3", limitMode: "machines" });
    const top = reinforcedIronPlateAssembler("top", "2/3");
    const bottom = reinforcedIronPlateAssembler("bottom", null);
    const snapshot: SolverSnapshot = {
      nodes: [bp, top, bottom],
      edges: [edge("e-top", "Iron Plate", "bp", "top", "top"), edge("e-bottom", "Iron Plate", "bp", "bottom", "bottom")],
    };

    const result = solve(snapshot, "full", defaultGameData);
    expect(result.valid).toBe(true);

    const bpResult = result.nodes.find((n) => n.nodeId === "bp")!;
    expect(equals(parseRational(bpResult.machineCount), of(3))).toBe(true);

    const topEdge = result.edges.find((e) => e.edgeId === "e-top")!;
    const bottomEdge = result.edges.find((e) => e.edgeId === "e-bottom")!;
    expect(topEdge.valid).toBe(true);
    expect(bottomEdge.valid).toBe(true);
    expect(equals(parseRational(topEdge.rate), of(20))).toBe(true);
    expect(equals(parseRational(bottomEdge.rate), of(10))).toBe(true); // genuine overflow, not zero and not a fallback

    const bottomResult = result.nodes.find((n) => n.nodeId === "bottom")!;
    expect(bottomResult.resolved).toBe(true); // resolved via propagation, NOT the "no limit" fallback
    expect(equals(parseRational(bottomResult.machineCount), of(1, 3))).toBe(true);
  });

  it("determinism: shuffled node/edge order produces byte-identical output through a blueprint compound node", () => {
    const bp = blueprintNode("bp", { "Iron Plate": "15" }, { perCopyPowerMW: -10 });
    const assembler = reinforcedIronPlateAssembler("assembler", "3");
    const nodes = [bp, assembler];
    const edges = [edge("e1", "Iron Plate", "bp", "assembler")];

    const forward = solve({ nodes, edges }, "basic", defaultGameData);
    const reversed = solve({ nodes: [...nodes].reverse(), edges: [...edges].reverse() }, "basic", defaultGameData);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});
