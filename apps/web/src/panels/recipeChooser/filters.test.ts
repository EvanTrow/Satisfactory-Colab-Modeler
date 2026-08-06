import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";

import {
  EMPTY_RECIPE_FILTERS,
  buildNodeInputForRecipe,
  filterRecipes,
  listChooserMachines,
  listChooserTiers,
} from "./filters";

const gameData = defaultGameData;

describe("filterRecipes", () => {
  it("returns every recipe when no filter is active (332 recipes, 110 alternates per job 009's acceptance criteria)", () => {
    const all = filterRecipes(gameData, EMPTY_RECIPE_FILTERS);
    expect(all).toHaveLength(332);
    expect(all.filter((r) => r.alternate)).toHaveLength(110);
  });

  it("filters by machine alone", () => {
    const result = filterRecipes(gameData, { ...EMPTY_RECIPE_FILTERS, machine: "Assembler" });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.machine === "Assembler")).toBe(true);
    // Cross-check against @scm/gamedata's own index rather than a hardcoded count.
    expect(result).toHaveLength(gameData.recipesByMachine.get("Assembler")?.length ?? -1);
  });

  it("filters by tier alone", () => {
    const tier = gameData.recipes[0]!.tier;
    const result = filterRecipes(gameData, { ...EMPTY_RECIPE_FILTERS, tier: tier.raw });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.tier.raw === tier.raw)).toBe(true);
  });

  it("filters by alternate-only alone", () => {
    const result = filterRecipes(gameData, { ...EMPTY_RECIPE_FILTERS, alternatesOnly: true });
    expect(result).toHaveLength(110);
    expect(result.every((r) => r.alternate)).toBe(true);
  });

  it("filters by search text alone (case-insensitive substring)", () => {
    const result = filterRecipes(gameData, { ...EMPTY_RECIPE_FILTERS, search: "iron" });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.name.toLowerCase().includes("iron"))).toBe(true);
  });

  it("composes name + machine + tier + alternate-only together (all four filters at once), matching an independently-written predicate", () => {
    // Pick a machine/tier combination that's guaranteed non-trivial: the
    // machine and tier of some alternate recipe whose name contains "e".
    const seedAlternate = gameData.recipes.find((r) => r.alternate && r.name.toLowerCase().includes("e"));
    expect(seedAlternate).toBeDefined();
    const filters = {
      search: "e",
      machine: seedAlternate!.machine,
      tier: seedAlternate!.tier.raw,
      alternatesOnly: true,
    };

    const actual = filterRecipes(gameData, filters);

    // Independently-written expectation (does not reuse filterRecipes'
    // implementation) so this test can't just be checking the function
    // against itself.
    const expected = gameData.recipes.filter(
      (r) =>
        r.name.toLowerCase().includes("e") &&
        r.machine === seedAlternate!.machine &&
        r.tier.raw === seedAlternate!.tier.raw &&
        r.alternate,
    );

    expect(actual.map((r) => r.name).sort()).toEqual(expected.map((r) => r.name).sort());
    expect(actual.length).toBeGreaterThan(0);
    // Narrower than any single filter applied alone.
    expect(actual.length).toBeLessThanOrEqual(filterRecipes(gameData, { ...EMPTY_RECIPE_FILTERS, machine: seedAlternate!.machine }).length);
  });

  it("returns an empty list when filters exclude everything", () => {
    const result = filterRecipes(gameData, {
      ...EMPTY_RECIPE_FILTERS,
      search: "this recipe name does not exist anywhere in game_data.json",
    });
    expect(result).toEqual([]);
  });
});

describe("listChooserMachines / listChooserTiers", () => {
  it("lists exactly the machines that appear in recipesByMachine, sorted", () => {
    const machines = listChooserMachines(gameData);
    expect(machines).toEqual(Array.from(gameData.recipesByMachine.keys()).sort((a, b) => a.localeCompare(b)));
    expect(machines).toHaveLength(24);
  });

  it("lists every distinct tier used by a recipe, sorted low to high", () => {
    const tiers = listChooserTiers(gameData);
    expect(tiers.length).toBeGreaterThan(0);
    for (let i = 1; i < tiers.length; i++) {
      const prev = tiers[i - 1]!;
      const cur = tiers[i]!;
      expect(prev.tier < cur.tier || (prev.tier === cur.tier && prev.milestone < cur.milestone)).toBe(true);
    }
  });
});

describe("buildNodeInputForRecipe", () => {
  const containerId = "c_root";
  const position = { x: 123, y: 456 };

  it("resolves a plain-machine recipe straight through, with purity null", () => {
    const recipe = gameData.recipesByMachine.get("Assembler")![0]!;
    const input = buildNodeInputForRecipe({ gameData, recipe, containerId, position });

    expect(input).toMatchObject({
      containerId,
      kind: "recipe",
      recipe: recipe.name,
      machine: "Assembler",
      x: 123,
      y: 456,
      title: recipe.name,
      purity: null,
      limit: null,
      clock: null,
      limitMode: "machines",
      autoRound: false,
      shards: 0,
    });
  });

  it("defaults a MultiMachine recipe (Miner) to Mk.1 x Normal when no variant is chosen", () => {
    const recipe = gameData.recipesByName.get("Iron Ore")!;
    expect(recipe.machine).toBe("Miner");

    const input = buildNodeInputForRecipe({ gameData, recipe, containerId, position });

    expect(input.machine).toBe("Miner Mk.1");
    expect(input.purity).toBe("normal");
    expect(input.recipe).toBe("Iron Ore");
  });

  it("honors an explicit MultiMachine variant choice (Miner Mk.3 x Pure)", () => {
    const recipe = gameData.recipesByName.get("Iron Ore")!;

    const input = buildNodeInputForRecipe({
      gameData,
      recipe,
      containerId,
      position,
      variantChoice: { model: "Miner Mk.3", capacity: "Pure" },
    });

    expect(input.machine).toBe("Miner Mk.3");
    expect(input.purity).toBe("pure");
  });

  it("resolves a model-less, capacity-only MultiMachine (Geothermal Generator)", () => {
    const recipe = gameData.recipesByName.get("Geothermal Generator")!;
    expect(recipe.machine).toBe("Geothermal Generator");

    const input = buildNodeInputForRecipe({
      gameData,
      recipe,
      containerId,
      position,
      variantChoice: { capacity: "Pure" },
    });

    expect(input.machine).toBe("Geothermal Generator");
    expect(input.purity).toBe("pure");
  });

  it("resolves a model-less, capacity-less MultiMachine (Space Elevator) with purity null", () => {
    const recipe = gameData.recipesByName.get("Space Elevator Phase 1")!;
    expect(recipe.machine).toBe("Space Elevator");

    const input = buildNodeInputForRecipe({ gameData, recipe, containerId, position });

    expect(input.machine).toBe("Space Elevator");
    expect(input.purity).toBeNull();
  });
});
