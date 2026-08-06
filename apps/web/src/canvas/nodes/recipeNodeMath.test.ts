import { defaultGameData } from "@scm/gamedata";
import { ONE, ZERO, equals, of, toFractionString, type Rational } from "@scm/rational";
import { describe, expect, it } from "vitest";

import {
  MAX_CLOCK_PERCENT,
  MIN_CLOCK_PERCENT,
  clampClockPercent,
  clampShards,
  computeMachineCount,
  defaultLimitMode,
  effectiveClockPercent,
  effectiveLimitValue,
  primaryPart,
  ratePerMachineAtFullClock,
  referenceRateAtFullClock,
  snapClockToWholeMachineCount,
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

describe("snapClockToWholeMachineCount — pure cases", () => {
  it("'+' (roundDown) from a non-integer count lands exactly on the floor", () => {
    const result = snapClockToWholeMachineCount(of(100), of(7, 2) /* 3.5 */, "roundDown");
    expect(toFractionString(result.machineCount)).toBe("3");
    expect(toFractionString(result.clockPercent)).toBe("350/3");
    expect(result.clamped).toBe(false);
  });

  it("'-' (roundUp) from a non-integer count lands exactly on the ceiling", () => {
    const result = snapClockToWholeMachineCount(of(100), of(7, 2) /* 3.5 */, "roundUp");
    expect(toFractionString(result.machineCount)).toBe("4");
    expect(toFractionString(result.clockPercent)).toBe("175/2");
    expect(result.clamped).toBe(false);
  });

  it("'+' from an already-whole count moves to the next lower integer, not a no-op", () => {
    const result = snapClockToWholeMachineCount(of(100), of(3), "roundDown");
    expect(toFractionString(result.machineCount)).toBe("2");
    expect(toFractionString(result.clockPercent)).toBe("150");
  });

  it("'-' from an already-whole count moves to the next higher integer", () => {
    const result = snapClockToWholeMachineCount(of(100), of(3), "roundUp");
    expect(toFractionString(result.machineCount)).toBe("4");
    expect(toFractionString(result.clockPercent)).toBe("75");
  });

  it("caps the resulting clock at 250% and reports the genuine (non-integer) resulting count", () => {
    // count=2 @ clock=240, "+": target=1 machine -> exact clock would be 480%.
    const result = snapClockToWholeMachineCount(of(240), of(2), "roundDown");
    expect(result.clamped).toBe(true);
    expect(equals(result.clockPercent, MAX_CLOCK_PERCENT)).toBe(true);
    // 2 * 240 / 250 = 48/25 = 1.92, not a whole number — the clamp means the
    // snap couldn't fully land, and callers must display the real count.
    expect(toFractionString(result.machineCount)).toBe("48/25");
  });

  it("floors the resulting clock at 1% and reports the genuine resulting count", () => {
    // count=1 @ clock=1, "-": target=2 machines -> exact clock would be 0.5%.
    const result = snapClockToWholeMachineCount(of(1), ONE, "roundUp");
    expect(result.clamped).toBe(true);
    expect(equals(result.clockPercent, MIN_CLOCK_PERCENT)).toBe(true);
    expect(toFractionString(result.machineCount)).toBe("1");
  });

  it("holds steady (no division by zero) when the current machine count is zero", () => {
    const result = snapClockToWholeMachineCount(of(100), ZERO, "roundDown");
    expect(equals(result.machineCount, ZERO)).toBe(true);
    expect(result.clamped).toBe(false);
  });
});

describe("snapClockToWholeMachineCount — end-to-end against real gamedata (Iron Plate, ppm mode)", () => {
  const recipe = gameData.recipesByName.get("Iron Plate")!;
  const baseNode = { machine: "Constructor", purity: null, limit: "50", limitMode: "ppm" as const, clock: "100" };

  it("'+' (roundDown) from a non-integer 2.5-machine count re-derives to exactly 2 machines through the full pipeline", () => {
    const currentCount = computeMachineCount(gameData, recipe, baseNode);
    expect(toFractionString(currentCount)).toBe("5/2");

    const snap = snapClockToWholeMachineCount(effectiveClockPercent(baseNode), currentCount, "roundDown");
    expect(toFractionString(snap.clockPercent)).toBe("125");

    // Re-derive machine count from scratch via computeMachineCount at the
    // new clock — proves the whole pipeline round-trips exactly, not just
    // the isolated snap function.
    const newNode = { ...baseNode, clock: toFractionString(snap.clockPercent) };
    const recount = computeMachineCount(gameData, recipe, newNode);
    expect(recount.denominator).toBe(1n);
    expect(toFractionString(recount)).toBe("2");
  });

  it("'-' (roundUp) from the same starting point re-derives to exactly 3 machines", () => {
    const currentCount = computeMachineCount(gameData, recipe, baseNode);
    const snap = snapClockToWholeMachineCount(effectiveClockPercent(baseNode), currentCount, "roundUp");
    expect(toFractionString(snap.clockPercent)).toBe("250/3");

    const newNode = { ...baseNode, clock: toFractionString(snap.clockPercent) };
    const recount = computeMachineCount(gameData, recipe, newNode);
    expect(recount.denominator).toBe(1n);
    expect(toFractionString(recount)).toBe("3");
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
