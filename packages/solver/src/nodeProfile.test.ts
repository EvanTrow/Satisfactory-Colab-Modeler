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
import { buildNodeProfile, nodePower, pinnedMachineCount, resourceExtractorSoftDefault } from "./nodeProfile";
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

describe("pinnedMachineCount: a null limit is always unpinned, in every mode", () => {
  // `pinnedMachineCount` itself has no graph awareness (see its own doc
  // comment), so a blank-ppm resource-extraction node (Miner/Water
  // Extractor/Oil Extractor/Resource Well Extractor) is NOT pinned here —
  // `basic.ts`'s/`full.ts`'s own two-phase pin step is what gives it a real
  // machine count (graph-derived first, `resourceExtractorSoftDefault`'s
  // flat 60ppm fallback second). See `resourceExtractorSoftDefault`'s own
  // describe block below, and `basic.ts`'s header comment (step 1b), for
  // that mechanism.
  it("returns unpinned ({}) for a null limit in ppm mode on a Miner", () => {
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
    expect(pinnedMachineCount(profile)).toEqual({});
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

  it("still returns unpinned ({}) for a null limit in ppm mode on a synthetic compound node (AWESOME Sink/Dimensional Depot/Storage Container consumer)", () => {
    // Reproduces `sinkPassthrough.ts`'s/`storagePassthrough.ts`'s exact
    // synthetic node shape: `syntheticCopyBasis` with a bookkeeping
    // per-copy rate, `limit: null`, `limitMode: "ppm"` (both modules
    // hardcode this pair for a freshly-connected, untouched sink/depot/
    // storage node).
    const node: SolverNode = {
      id: "sk:depot1:Iron Ore",
      recipe: "",
      machine: "",
      purity: null,
      limit: null,
      limitMode: "ppm",
      clock: null,
      shards: 0,
      syntheticCopyBasis: { perCopyRates: { "Iron Ore": "-1" }, perCopyPowerMW: 0 },
    };
    const profile = buildNodeProfile(node, defaultGameData);
    expect(profile.syntheticPowerAtOneUnit).toBeDefined();
    expect(pinnedMachineCount(profile)).toEqual({});
  });
});

describe("resourceExtractorSoftDefault", () => {
  it("targets exactly 60ppm on a Miner's primary part at 100% clock", () => {
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
    const count = resourceExtractorSoftDefault(profile);
    expect(count).toBeDefined();
    // Miner Mk.1 x Normal's own reference rate for Iron Ore IS 60/min, so
    // this coincides with exactly ONE machine.
    expect(equals(count!, of(1))).toBe(true);
  });

  it("still targets 60ppm (not the recipe's own 120/min rate) on a Water Extractor", () => {
    const node: SolverNode = {
      id: "water",
      recipe: "Water",
      machine: "Water Extractor",
      purity: null,
      limit: null,
      limitMode: "ppm",
      clock: null,
      shards: 0,
    };
    const profile = buildNodeProfile(node, defaultGameData);
    const count = resourceExtractorSoftDefault(profile);
    expect(count).toBeDefined();
    expect(equals(count!, of(1, 2))).toBe(true); // 60 / 120 per machine = 1/2
  });

  it("is undefined for a non-resource-extraction recipe, even blank ppm", () => {
    const node: SolverNode = {
      id: "n",
      recipe: "Iron Ingot",
      machine: "Smelter",
      purity: null,
      limit: null,
      limitMode: "ppm",
      clock: null,
      shards: 0,
    };
    const profile = buildNodeProfile(node, defaultGameData);
    expect(resourceExtractorSoftDefault(profile)).toBeUndefined();
  });

  it("is undefined once a limit is actually set", () => {
    const node: SolverNode = {
      id: "miner",
      recipe: "Iron Ore",
      machine: "Miner Mk.1",
      purity: "normal",
      limit: "30",
      limitMode: "ppm",
      clock: null,
      shards: 0,
    };
    const profile = buildNodeProfile(node, defaultGameData);
    expect(resourceExtractorSoftDefault(profile)).toBeUndefined();
  });
});
