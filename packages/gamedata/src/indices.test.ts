import { describe, expect, it } from "vitest";
import { of } from "@scm/rational";
import { buildRecipeIndices, compareTiers, parseTier } from "./indices";
import type { Recipe } from "./types";

describe("parseTier", () => {
  it("parses tier-milestone strings", () => {
    expect(parseTier("0-0")).toEqual({ tier: 0, milestone: 0, raw: "0-0" });
    expect(parseTier("9-5")).toEqual({ tier: 9, milestone: 5, raw: "9-5" });
    expect(parseTier("6-1")).toEqual({ tier: 6, milestone: 1, raw: "6-1" });
  });

  it("throws on a malformed tier string", () => {
    expect(() => parseTier("not-a-tier")).toThrow();
    expect(() => parseTier("6")).toThrow();
    expect(() => parseTier("")).toThrow();
  });
});

describe("compareTiers", () => {
  it("orders by tier first, then milestone", () => {
    expect(compareTiers(parseTier("0-5"), parseTier("1-0"))).toBe(-1);
    expect(compareTiers(parseTier("6-1"), parseTier("6-0"))).toBe(1);
    expect(compareTiers(parseTier("6-1"), parseTier("6-1"))).toBe(0);
  });
});

function makeRecipe(overrides: Partial<Recipe> & Pick<Recipe, "name" | "machine">): Recipe {
  return {
    batchTime: of(1),
    tier: parseTier("0-0"),
    parts: [],
    alternate: false,
    ficsmas: false,
    ignoreInputMultiplier: false,
    spaceElevatorMultiplier: false,
    isGenerator: false,
    ...overrides,
  };
}

describe("buildRecipeIndices", () => {
  const ironIngot = makeRecipe({
    name: "Iron Ingot",
    machine: "Smelter",
    parts: [
      { part: "Iron Ore", amount: of(-30) },
      { part: "Iron Ingot", amount: of(30) },
    ],
  });
  const ironAlloyIngot = makeRecipe({
    name: "Iron Alloy Ingot",
    machine: "Foundry",
    alternate: true,
    parts: [
      { part: "Iron Ore", amount: of(-40) },
      { part: "Copper Ore", amount: of(-10) },
      { part: "Iron Ingot", amount: of(75) },
    ],
  });
  const coalGenerator = makeRecipe({
    name: "Coal Generator",
    machine: "Coal-Powered Generator",
    ignoreInputMultiplier: true,
    isGenerator: true,
    parts: [
      { part: "Coal", amount: of(-15) },
      { part: "Water", amount: of(-45) },
    ],
  });

  const recipes = [ironIngot, ironAlloyIngot, coalGenerator];
  const indices = buildRecipeIndices(recipes);

  it("indexes recipes by machine", () => {
    expect(indices.recipesByMachine.get("Smelter")).toEqual([ironIngot]);
    expect(indices.recipesByMachine.get("Foundry")).toEqual([ironAlloyIngot]);
    expect(indices.recipesByMachine.get("Nonexistent Machine")).toBeUndefined();
  });

  it("indexes recipes by part as input", () => {
    const ironOreConsumers = indices.recipesByPartAsInput.get("Iron Ore");
    expect(ironOreConsumers).toEqual([ironIngot, ironAlloyIngot]);
    expect(indices.recipesByPartAsInput.get("Iron Ingot")).toBeUndefined();
  });

  it("indexes recipes by part as output", () => {
    const ironIngotProducers = indices.recipesByPartAsOutput.get("Iron Ingot");
    expect(ironIngotProducers).toEqual([ironIngot, ironAlloyIngot]);
    expect(indices.recipesByPartAsOutput.get("Coal")).toBeUndefined();
  });

  it("collects generator recipes", () => {
    expect(indices.generatorRecipes).toEqual([coalGenerator]);
  });
});
