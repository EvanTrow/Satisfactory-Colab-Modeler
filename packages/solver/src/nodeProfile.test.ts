// Unit tests for `nodeProfile.ts`'s pure per-node math, isolated from any
// graph. Includes the Converter/Particle Accelerator/Quantum Encoder power
// override gotcha flagged in jobs/003-gamedata-package.md's Handoff notes:
// "Recipe.averagePower ... should be treated as overriding
// Machine.averagePower for that recipe ... reading only
// machine.averagePower will silently give undefined/wrong power for those
// three machines' recipes."
import { defaultGameData } from "@scm/gamedata";
import { equals, of } from "@scm/rational";
import { describe, expect, it } from "vitest";
import { buildNodeProfile, nodePower, pinnedMachineCount } from "./nodeProfile";
import type { SolverNode } from "./snapshot";

describe("buildNodeProfile: Converter/Particle Accelerator/Quantum Encoder power override", () => {
  it("uses Recipe.averagePower, not Machine.averagePower (which the Converter has none of)", () => {
    // "Iron Ore (Limestone)" on Converter: MinPower -400, AveragePower -250
    // (per-recipe). The Converter `Machine` entry itself has NO
    // AveragePower field at all.
    const machine = defaultGameData.machinesByName.get("Converter");
    expect(machine?.averagePower).toBeUndefined();

    const node: SolverNode = {
      id: "converter",
      recipe: "Iron Ore (Limestone)",
      machine: "Converter",
      purity: null,
      limit: "1",
      limitMode: "machines",
      clock: null,
      shards: 0,
    };
    const profile = buildNodeProfile(node, defaultGameData);
    expect(profile.issues).toEqual([]);
    expect(profile.effectivePower).toBeDefined();
    expect(profile.effectivePower && profile.effectivePower.numerator).toBe(-250n);

    const power = nodePower(profile, of(1));
    expect(power).toBeCloseTo(-250, 10);
  });

  it("applies the same override on Particle Accelerator and Quantum Encoder recipes", () => {
    for (const [machineName, recipeName] of [
      ["Particle Accelerator", "Nuclear Pasta"],
      ["Quantum Encoder", "AI Expansion Server"],
    ] as const) {
      const recipesForMachine = [...defaultGameData.recipes].filter(
        (r) => r.machine === machineName && r.averagePower !== undefined,
      );
      expect(recipesForMachine.length).toBeGreaterThan(0);
      const recipe = recipesForMachine.find((r) => r.name === recipeName) ?? recipesForMachine[0]!;

      const node: SolverNode = {
        id: "node",
        recipe: recipe.name,
        machine: machineName,
        purity: null,
        limit: "1",
        limitMode: "machines",
        clock: null,
        shards: 0,
      };
      const profile = buildNodeProfile(node, defaultGameData);
      expect(profile.issues).toEqual([]);
      expect(profile.effectivePower).toEqual(recipe.averagePower);
    }
  });
});

describe("buildNodeProfile: robustness", () => {
  it("reports an issue instead of throwing for an unknown recipe", () => {
    const node: SolverNode = {
      id: "bad",
      recipe: "Nonexistent Recipe",
      machine: "Smelter",
      purity: null,
      limit: null,
      limitMode: "machines",
      clock: null,
      shards: 0,
    };
    const profile = buildNodeProfile(node, defaultGameData);
    expect(profile.recipe).toBeUndefined();
    expect(profile.issues.length).toBeGreaterThan(0);
  });

  it("reports an issue instead of throwing for shards exceeding the machine's max", () => {
    const node: SolverNode = {
      id: "over-shard",
      recipe: "Iron Ingot",
      machine: "Smelter",
      purity: null,
      limit: null,
      limitMode: "machines",
      clock: null,
      shards: 4, // Smelter supports 0 production shards
    };
    const profile = buildNodeProfile(node, defaultGameData);
    expect(profile.recipe).toBeDefined();
    expect(profile.issues.length).toBeGreaterThan(0);
  });

  it("clamps an out-of-range clock into [1, 250]", () => {
    const tooHigh: SolverNode = {
      id: "n",
      recipe: "Iron Ingot",
      machine: "Smelter",
      purity: null,
      limit: null,
      limitMode: "machines",
      clock: "9999",
      shards: 0,
    };
    const tooLow: SolverNode = { ...tooHigh, clock: "0" };
    expect(buildNodeProfile(tooHigh, defaultGameData).clockPercent).toEqual(of(250));
    expect(buildNodeProfile(tooLow, defaultGameData).clockPercent).toEqual(of(1));
  });
});

describe("pinnedMachineCount: untouched ppm-mode default (Miner/AWESOME Sink)", () => {
  it("treats a null limit in ppm mode as pinned to the recipe's own 100%-clock reference rate, not the ONE-machine fallback", () => {
    // A freshly-placed Miner (`limit: null`, `limitMode: "ppm"`, per
    // `recipeNodeMath.ts`'s `defaultLimitMode`) shows "60/min" in the UI —
    // this must actually resolve to that same 1 machine (Miner Mk.1 at
    // 100% clock's own reference rate for Iron Ore IS 60/min, so this
    // particular case coincides with the old ONE-machine fallback's
    // number, but for the RIGHT reason: it's pinned to the rate, not to a
    // bare machine count — see the next test for a case where the two
    // diverge).
    const node: SolverNode = {
      id: "miner",
      recipe: "Iron Ore",
      machine: "Miner Mk.1",
      purity: "normal",
      limit: null,
      limitMode: "ppm",
      clock: null,
      shards: 0,
    };
    const profile = buildNodeProfile(node, defaultGameData);
    const result = pinnedMachineCount(profile);
    expect(result.issue).toBeUndefined();
    expect(result.count).toBeDefined();
    expect(equals(result.count!, of(1))).toBe(true);
  });

  it("scales machine count to hold the reference rate steady when the clock is untouched but non-default", () => {
    // At 50% clock, ONE machine only produces 30/min — holding the
    // pinned TARGET rate at 60/min (what the UI still displays,
    // `recipeNodeMath.ts`'s `effectiveLimitValue` ignores the node's own
    // clock) means 2 machines are needed, not 1. This is what
    // distinguishes "pinned to a rate" from the old "pinned to exactly
    // ONE machine" fallback.
    const node: SolverNode = {
      id: "miner",
      recipe: "Iron Ore",
      machine: "Miner Mk.1",
      purity: "normal",
      limit: null,
      limitMode: "ppm",
      clock: "50",
      shards: 0,
    };
    const profile = buildNodeProfile(node, defaultGameData);
    const result = pinnedMachineCount(profile);
    expect(result.issue).toBeUndefined();
    expect(equals(result.count!, of(2))).toBe(true);
  });

  it("still returns unpinned ({}) for a null limit in machine-count mode — 'derive from the graph' is untouched", () => {
    const node: SolverNode = {
      id: "smelter",
      recipe: "Iron Ingot",
      machine: "Smelter",
      purity: null,
      limit: null,
      limitMode: "machines",
      clock: null,
      shards: 0,
    };
    const profile = buildNodeProfile(node, defaultGameData);
    expect(pinnedMachineCount(profile)).toEqual({});
  });
});
