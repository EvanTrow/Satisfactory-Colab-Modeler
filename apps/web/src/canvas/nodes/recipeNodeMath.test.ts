import { defaultGameData, type RecipePart } from "@scm/gamedata";
import { ONE, ZERO, equals, of, toFractionString, type Rational } from "@scm/rational";
import { describe, expect, it } from "vitest";

import {
  CLOCK_PRESETS,
  MAX_CLOCK_PERCENT,
  MIN_CLOCK_PERCENT,
  clampClockPercent,
  clampShards,
  computeMachineCount,
  defaultLimitMode,
  effectiveClockPercent,
  effectiveLimitValue,
  orderRecipeParts,
  partHandleId,
  primaryPart,
  ratePerMachineAtFullClock,
  referenceRateAtFullClock,
  stepClockToPreset,
  stopgapPartRate,
} from "./recipeNodeMath";

const gameData = defaultGameData;

describe("defaultLimitMode", () => {
  it("defaults Miner and AWESOME Sink to ppm", () => {
    expect(defaultLimitMode("Miner")).toBe("ppm");
    expect(defaultLimitMode("AWESOME Sink")).toBe("ppm");
  });

  it("defaults every other machine to machine count", () => {
    expect(defaultLimitMode("Assembler")).toBe("machines");
    expect(defaultLimitMode("Constructor")).toBe("machines");
    expect(defaultLimitMode("Oil Extractor")).toBe("machines");
    expect(defaultLimitMode("Space Elevator")).toBe("machines");
  });
});

describe("primaryPart", () => {
  it("picks the (sole) output for a normal recipe", () => {
    const recipe = gameData.recipesByName.get("Iron Plate")!;
    const part = primaryPart(recipe);
    expect(part?.part).toBe("Iron Plate");
  });

  it("falls back to the largest-magnitude input when a recipe has no outputs (a generator recipe)", () => {
    const generator = gameData.generatorRecipes[0]!;
    expect(generator.parts.some((p) => p.amount.numerator > 0n)).toBe(false);
    const part = primaryPart(generator);
    expect(part).toBeDefined();
    expect(generator.parts).toContainEqual(part);
  });

  it("returns undefined for a zero-part recipe", () => {
    const recipe = gameData.recipesByName.get("Geothermal Generator")!;
    expect(recipe.parts).toHaveLength(0);
    expect(primaryPart(recipe)).toBeUndefined();
  });
});

describe("rate helpers against real gamedata", () => {
  it("matches PLAN.md's Miner Mk.3 on Pure = 480/min example", () => {
    const recipe = gameData.recipesByName.get("Iron Ore")!;
    expect(recipe.machine).toBe("Miner");
    const rate = ratePerMachineAtFullClock(gameData, recipe, { machine: "Miner Mk.3", purity: "pure" }, "Iron Ore");
    expect(toFractionString(rate)).toBe("480");
  });

  it("disambiguates a capacity-only MultiMachine (Geothermal Generator has no models) via purity alone", () => {
    // Geothermal Generator has no `parts` to check a rate against, but every
    // capacity variant shares the same `machine.name` — this exercises the
    // same purity-disambiguation path Miner needs, on a family where a bug
    // would otherwise be invisible (matches would still resolve *a*
    // variant, just possibly the wrong one).
    const recipe = gameData.recipesByName.get("Geothermal Generator")!;
    expect(recipe.parts).toHaveLength(0);
    // No RecipePart to rate, so just confirm referenceRateAtFullClock
    // degrades to ZERO cleanly rather than throwing on the ambiguous lookup.
    expect(equals(referenceRateAtFullClock(gameData, recipe, { machine: "Geothermal Generator", purity: "pure" }), ZERO)).toBe(true);
  });

  it("computes the correct base rate for a plain-machine recipe (Iron Plate, Constructor)", () => {
    const recipe = gameData.recipesByName.get("Iron Plate")!;
    const output = ratePerMachineAtFullClock(gameData, recipe, { machine: "Constructor", purity: null }, "Iron Plate");
    const input = ratePerMachineAtFullClock(gameData, recipe, { machine: "Constructor", purity: null }, "Iron Ingot");
    expect(toFractionString(output)).toBe("20");
    expect(toFractionString(input)).toBe("-30");
  });
});

describe("effectiveClockPercent / effectiveLimitValue", () => {
  it("defaults clock to 100 when null", () => {
    expect(equals(effectiveClockPercent({ clock: null }), of(100))).toBe(true);
  });

  it("clamps an out-of-range stored clock", () => {
    expect(equals(effectiveClockPercent({ clock: "9999" }), MAX_CLOCK_PERCENT)).toBe(true);
    expect(equals(effectiveClockPercent({ clock: "0" }), MIN_CLOCK_PERCENT)).toBe(true);
  });

  it("defaults limit to 1 machine when null and mode is machines", () => {
    const recipe = gameData.recipesByName.get("Iron Plate")!;
    const value = effectiveLimitValue(gameData, recipe, {
      machine: "Constructor",
      purity: null,
      limit: null,
      limitMode: "machines",
    });
    expect(equals(value, ONE)).toBe(true);
  });

  it("defaults limit to the primary part's full-clock rate when null and mode is ppm", () => {
    const recipe = gameData.recipesByName.get("Iron Ore")!;
    const value = effectiveLimitValue(gameData, recipe, {
      machine: "Miner Mk.1",
      purity: "normal",
      limit: null,
      limitMode: "ppm",
    });
    // Mk.1 x Normal = 1 x 60 x 1 = 60/min (see machines.ts's own PartsRatio docs).
    expect(toFractionString(value)).toBe("60");
  });
});

describe("computeMachineCount + stopgapPartRate (Iron Plate on a Constructor)", () => {
  const recipe = gameData.recipesByName.get("Iron Plate")!;
  const outputPart = recipe.parts.find((p) => p.part === "Iron Plate")!;
  const inputPart = recipe.parts.find((p) => p.part === "Iron Ingot")!;

  it("machines mode anchors machine count to `limit` exactly at 100% clock", () => {
    const node = { machine: "Constructor", purity: null, limit: "3", limitMode: "machines" as const, clock: "100" };
    expect(toFractionString(computeMachineCount(gameData, recipe, node))).toBe("3");
    expect(toFractionString(stopgapPartRate(gameData, recipe, node, outputPart))).toBe("60");
    expect(toFractionString(stopgapPartRate(gameData, recipe, node, inputPart))).toBe("-90");
  });

  it("machines mode at a non-100% clock scales machine count inversely with clock, holding target rate fixed", () => {
    const node = { machine: "Constructor", purity: null, limit: "3", limitMode: "machines" as const, clock: "150" };
    // Same target rate as the 100%-clock case above (60/min), fewer machines needed.
    expect(toFractionString(computeMachineCount(gameData, recipe, node))).toBe("2");
  });

  it("ppm mode divides the requested rate by the per-machine rate at the current clock", () => {
    const node = { machine: "Constructor", purity: null, limit: "50", limitMode: "ppm" as const, clock: "100" };
    expect(toFractionString(computeMachineCount(gameData, recipe, node))).toBe("5/2");
  });

  it("returns ZERO for a zero-part recipe regardless of limit", () => {
    const geo = gameData.recipesByName.get("Geothermal Generator")!;
    const node = { machine: "Geothermal Generator", purity: "normal" as const, limit: "10", limitMode: "machines" as const, clock: "100" };
    expect(equals(computeMachineCount(gameData, geo, node), ZERO)).toBe(true);
  });
});

describe("CLOCK_PRESETS", () => {
  it("spans [MIN_CLOCK_PERCENT, MAX_CLOCK_PERCENT] in ascending 25-point steps", () => {
    expect(CLOCK_PRESETS.map((p) => toFractionString(p))).toEqual([
      "1",
      "25",
      "50",
      "75",
      "100",
      "125",
      "150",
      "175",
      "200",
      "225",
      "250",
    ]);
    expect(equals(CLOCK_PRESETS[0], MIN_CLOCK_PERCENT)).toBe(true);
    expect(equals(CLOCK_PRESETS[CLOCK_PRESETS.length - 1], MAX_CLOCK_PERCENT)).toBe(true);
  });
});

describe("stepClockToPreset", () => {
  it("'up' from an exact preset moves to the next preset", () => {
    expect(toFractionString(stepClockToPreset(of(100), "up"))).toBe("125");
  });

  it("'down' from an exact preset moves to the previous preset", () => {
    expect(toFractionString(stepClockToPreset(of(100), "down"))).toBe("75");
  });

  it("'up' from a value between presets moves to the nearest preset above", () => {
    expect(toFractionString(stepClockToPreset(of(137), "up"))).toBe("150");
  });

  it("'down' from a value between presets moves to the nearest preset below", () => {
    expect(toFractionString(stepClockToPreset(of(137), "down"))).toBe("125");
  });

  it("'up' holds at the top preset once there's nothing further up", () => {
    expect(toFractionString(stepClockToPreset(of(250), "up"))).toBe("250");
  });

  it("'down' holds at the bottom preset once there's nothing further down", () => {
    expect(toFractionString(stepClockToPreset(of(1), "down"))).toBe("1");
  });
});

describe("clampClockPercent", () => {
  it("clamps into [1, 250]", () => {
    expect(equals(clampClockPercent(of(-5)), MIN_CLOCK_PERCENT)).toBe(true);
    expect(equals(clampClockPercent(of(0)), MIN_CLOCK_PERCENT)).toBe(true);
    expect(equals(clampClockPercent(of(300)), MAX_CLOCK_PERCENT)).toBe(true);
    const mid = of(150) as Rational;
    expect(equals(clampClockPercent(mid), mid)).toBe(true);
  });
});

describe("clampShards", () => {
  it("clamps into [0, maxShards], rounding first", () => {
    expect(clampShards(-1, 4)).toBe(0);
    expect(clampShards(2.6, 4)).toBe(3);
    expect(clampShards(10, 4)).toBe(4);
    expect(clampShards(2, 0)).toBe(0);
    expect(clampShards(Number.NaN, 4)).toBe(0);
  });
});

function part(name: string, amount: number): RecipePart {
  return { part: name, amount: of(amount) };
}

describe("partHandleId", () => {
  it("prefixes a consumed part (negative amount) with 'in:'", () => {
    expect(partHandleId(part("Iron Ore", -30))).toBe("in:Iron Ore");
  });

  it("prefixes a produced part (positive amount) with 'out:'", () => {
    expect(partHandleId(part("Iron Ingot", 30))).toBe("out:Iron Ingot");
  });
});

describe("orderRecipeParts", () => {
  const screw = part("Screw", -20);
  const plate = part("Iron Plate", -10);
  const rod = part("Iron Rod", -5);
  const output = part("Reinforced Iron Plate", 5);
  const parts = [screw, plate, rod, output];

  it("with no priorityOrder, groups inputs before outputs and keeps each group's recipe-authored order", () => {
    expect(orderRecipeParts(parts, [])).toEqual([screw, plate, rod, output]);
  });

  it("reorders within a group to match priorityOrder's rank", () => {
    const result = orderRecipeParts(parts, ["in:Iron Rod", "in:Iron Plate", "in:Screw"]);
    expect(result.map((p) => p.part)).toEqual(["Iron Rod", "Iron Plate", "Screw", "Reinforced Iron Plate"]);
  });

  it("appends parts absent from priorityOrder after the ranked ones, in their original relative order", () => {
    // Only Screw has been explicitly placed (moved to the front of its
    // group); Iron Plate/Iron Rod keep their recipe-authored relative order
    // and sort after it.
    const result = orderRecipeParts(parts, ["in:Screw"]);
    expect(result.map((p) => p.part)).toEqual(["Screw", "Iron Plate", "Iron Rod", "Reinforced Iron Plate"]);
  });

  it("never mixes inputs and outputs regardless of priorityOrder's own ordering", () => {
    // Even though the output is ranked *before* the inputs here, inputs
    // still lead the outputs — the two groups are always kept separate.
    const result = orderRecipeParts(parts, ["out:Reinforced Iron Plate", "in:Screw"]);
    expect(result.map((p) => p.part)).toEqual(["Screw", "Iron Plate", "Iron Rod", "Reinforced Iron Plate"]);
  });

  it("ignores stale priorityOrder entries for parts no longer on the recipe", () => {
    const result = orderRecipeParts(parts, ["in:Copper Ore", "in:Iron Rod"]);
    expect(result.map((p) => p.part)).toEqual(["Iron Rod", "Screw", "Iron Plate", "Reinforced Iron Plate"]);
  });
});
