import { defaultGameData, type Recipe } from "@scm/gamedata";
import { isNegative } from "@scm/rational";
import { describe, expect, it } from "vitest";

import { WILDCARD_PART, WILDCARD_PART_BOTTOM, WILDCARD_PART_TOP } from "../../canvas/edges/connectionLogic";
import {
  EMPTY_RECIPE_FILTERS,
  NO_PROGRESSION_FILTER,
  buildNodeInputForRecipe,
  filterRecipes,
  initialFiltersForPendingPart,
  listChooserMachines,
  listChooserTiers,
  matchingHandleId,
  sortRecipesForChooser,
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

  it("filters by search text alone (case-insensitive substring), matching name/inputs/outputs together by default", () => {
    const result = filterRecipes(gameData, { ...EMPTY_RECIPE_FILTERS, search: "iron" });
    expect(result.length).toBeGreaterThan(0);
    expect(
      result.every(
        (r) => r.name.toLowerCase().includes("iron") || r.parts.some((p) => p.part.toLowerCase().includes("iron")),
      ),
    ).toBe(true);
    // Narrower search-by-name-only is a strict subset of the default combined search.
    const nameOnly = filterRecipes(gameData, { ...EMPTY_RECIPE_FILTERS, search: "iron", searchByInputs: false, searchByOutputs: false });
    expect(nameOnly.every((r) => r.name.toLowerCase().includes("iron"))).toBe(true);
    expect(nameOnly.length).toBeLessThanOrEqual(result.length);
  });

  it("with only searchByName on, matches name but ignores a recipe whose name doesn't contain the term even if an input/output does", () => {
    const recipe = gameData.recipesByName.get("Iron Ingot")!;
    const inputPart = recipe.parts.find((p) => isNegative(p.amount))!.part;
    const result = filterRecipes(gameData, {
      ...EMPTY_RECIPE_FILTERS,
      search: inputPart.toLowerCase(),
      searchByName: true,
      searchByInputs: false,
      searchByOutputs: false,
    });
    expect(result.some((r) => r.name === "Iron Ingot")).toBe(false);
  });

  it("with only searchByInputs on, matches a recipe that consumes the searched part, not one that only produces it", () => {
    const result = filterRecipes(gameData, {
      ...EMPTY_RECIPE_FILTERS,
      search: "iron ore",
      searchByName: false,
      searchByInputs: true,
      searchByOutputs: false,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.parts.some((p) => isNegative(p.amount) && p.part.toLowerCase().includes("iron ore")))).toBe(true);
    // "Iron Ore" recipes (Miner) PRODUCE ore, they don't consume it — excluded.
    expect(result.some((r) => r.name === "Iron Ore")).toBe(false);
  });

  it("with only searchByOutputs on, matches a recipe that produces the searched part", () => {
    const result = filterRecipes(gameData, {
      ...EMPTY_RECIPE_FILTERS,
      search: "iron ore",
      searchByName: false,
      searchByInputs: false,
      searchByOutputs: true,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.parts.some((p) => !isNegative(p.amount) && p.part.toLowerCase().includes("iron ore")))).toBe(true);
    expect(result.some((r) => r.name === "Iron Ore")).toBe(true);
  });

  it("matches nothing when the search text is non-empty but every switch is off", () => {
    const result = filterRecipes(gameData, {
      ...EMPTY_RECIPE_FILTERS,
      search: "iron",
      searchByName: false,
      searchByInputs: false,
      searchByOutputs: false,
    });
    expect(result).toEqual([]);
  });

  it("composes name + machine + tier + alternate-only together (all four filters at once), matching an independently-written predicate", () => {
    // Pick a machine/tier combination that's guaranteed non-trivial: the
    // machine and tier of some alternate recipe whose name contains "e".
    const seedAlternate = gameData.recipes.find((r) => r.alternate && r.name.toLowerCase().includes("e"));
    expect(seedAlternate).toBeDefined();
    const filters = {
      search: "e",
      // Isolated to name-only so this test keeps composing the OTHER three
      // filters against a plain by-name predicate — the search box's own
      // name/inputs/outputs OR-composition has its own dedicated tests
      // above.
      searchByName: true,
      searchByInputs: false,
      searchByOutputs: false,
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

  it("defaults to no progression filtering (all 332 recipes) when the third argument is omitted", () => {
    expect(filterRecipes(gameData, EMPTY_RECIPE_FILTERS)).toHaveLength(332);
    expect(filterRecipes(gameData, EMPTY_RECIPE_FILTERS, NO_PROGRESSION_FILTER)).toHaveLength(332);
  });

  it("applies a cumulative tier progression filter (tier <= N), not an exact match", () => {
    const result = filterRecipes(gameData, EMPTY_RECIPE_FILTERS, { tier: 3, phase: null });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.tier.tier <= 3)).toBe(true);
    // Includes tier 0 recipes too (cumulative, not exact).
    expect(result.some((r) => r.tier.tier === 0)).toBe(true);
    // Excludes anything past tier 3.
    expect(result.some((r) => r.tier.tier > 3)).toBe(false);
    expect(result.length).toBeLessThan(332);
  });

  it("applies a cumulative Space Elevator phase filter, resolved via progression.ts's delivery-unlock table", () => {
    // Phase 1 (Distribution Platform) unlocks Tiers 3 and 4 — see progression.ts.
    const result = filterRecipes(gameData, EMPTY_RECIPE_FILTERS, { tier: null, phase: 1 });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.tier.tier <= 4)).toBe(true);
    expect(result.some((r) => r.tier.tier === 4)).toBe(true);
    expect(result.length).toBeLessThan(332);
  });

  it("ANDs tier and phase together when both are set (the stricter cap wins)", () => {
    const tierOnly = filterRecipes(gameData, EMPTY_RECIPE_FILTERS, { tier: 2, phase: null });
    // Phase 1 alone caps at Tier 4, tier 2 alone caps at Tier 2 — the AND is the stricter, Tier 2.
    const both = filterRecipes(gameData, EMPTY_RECIPE_FILTERS, { tier: 2, phase: 1 });
    expect(both.length).toBeLessThanOrEqual(tierOnly.length);
    expect(both.every((r) => r.tier.tier <= 2)).toBe(true);
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
    // Job 010: Miner recipes default to ppm (PLAN.md §2's "Set a limit" row).
    expect(input.limitMode).toBe("ppm");
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

describe("initialFiltersForPendingPart", () => {
  it("dragging from an OUTPUT searches recipes' INPUTS for that part", () => {
    const filters = initialFiltersForPendingPart("out", "Iron Ore");
    expect(filters).toMatchObject({
      search: "Iron Ore",
      searchByName: false,
      searchByInputs: true,
      searchByOutputs: false,
    });
  });

  it("dragging from a Splurger's wildcard port opens unfiltered — there's no real part name to search by", () => {
    expect(initialFiltersForPendingPart("out", WILDCARD_PART)).toEqual(EMPTY_RECIPE_FILTERS);
    expect(initialFiltersForPendingPart("in", WILDCARD_PART)).toEqual(EMPTY_RECIPE_FILTERS);
  });

  it("dragging from a tiered Priority Splitter/Merger/Splurger port (*top/*bottom) is unfiltered too", () => {
    expect(initialFiltersForPendingPart("out", WILDCARD_PART_TOP)).toEqual(EMPTY_RECIPE_FILTERS);
    expect(initialFiltersForPendingPart("in", WILDCARD_PART_BOTTOM)).toEqual(EMPTY_RECIPE_FILTERS);
  });

  it("dragging from an INPUT searches recipes' OUTPUTS for that part", () => {
    const filters = initialFiltersForPendingPart("in", "Iron Ingot");
    expect(filters).toMatchObject({
      search: "Iron Ingot",
      searchByName: false,
      searchByInputs: false,
      searchByOutputs: true,
    });
  });
});

describe("sortRecipesForChooser", () => {
  // "Iron Ingot" (Smelter, standard, Tier 0-0): consumes only Iron Ore, a
  // Miner recipe with no inputs of its own (cost depth 0) — so Iron Ingot
  // itself lands at cost depth 1. Used below as a base to build synthetic
  // recipes that isolate one tiebreak level at a time.
  const base = defaultGameData.recipesByName.get("Iron Ingot")!;

  it("sorts every recipe with no input parts (cost depth 0) before every recipe that has at least one input, WITHIN the non-seasonal group", () => {
    // Cost only orders recipes relative to others in the SAME
    // seasonal/non-seasonal group now — seasonal-last is the outermost key,
    // so a seasonal no-input recipe (e.g. "FICSMAS Gift") still sorts after
    // a non-seasonal has-input one (see the dedicated seasonal-grouping
    // tests below for that). Scoped to non-`ficsmas` recipes only, so this
    // stays a true statement.
    const sorted = sortRecipesForChooser(
      defaultGameData,
      defaultGameData.recipes.filter((r) => !r.ficsmas),
    );
    const hasInput = (r: Recipe) => r.parts.some((p) => isNegative(p.amount));
    const firstWithInputIndex = sorted.findIndex(hasInput);
    expect(firstWithInputIndex).toBeGreaterThan(0);
    // Nothing after the first "has an input" recipe should be a no-input one.
    expect(sorted.slice(firstWithInputIndex).every(hasInput)).toBe(true);
  });

  it("places a Miner's ore recipe (cost depth 0) before the Smelter recipe consuming it (cost depth 1)", () => {
    const sorted = sortRecipesForChooser(defaultGameData, defaultGameData.recipes);
    const oreIndex = sorted.findIndex((r) => r.name === "Iron Ore");
    const ingotIndex = sorted.findIndex((r) => r.name === "Iron Ingot");
    expect(oreIndex).toBeGreaterThan(-1);
    expect(ingotIndex).toBeGreaterThan(-1);
    expect(oreIndex).toBeLessThan(ingotIndex);
  });

  it("groups every seasonal (FICSMAS) recipe after every non-seasonal recipe, as two back-to-back blocks", () => {
    const sorted = sortRecipesForChooser(defaultGameData, defaultGameData.recipes);
    const isFicsmas = (r: Recipe) => r.ficsmas;
    const firstFicsmasIndex = sorted.findIndex(isFicsmas);
    expect(firstFicsmasIndex).toBeGreaterThan(0);
    // Nothing before the first FICSMAS recipe is itself FICSMAS, and
    // nothing from that point on is NOT FICSMAS — a clean two-group split,
    // not seasonal items scattered through their own cost/tier buckets.
    expect(sorted.slice(0, firstFicsmasIndex).some(isFicsmas)).toBe(false);
    expect(sorted.slice(firstFicsmasIndex).every(isFicsmas)).toBe(true);
  });

  it("outranks cost depth — a depth-0 seasonal recipe sorts AFTER a deeper non-seasonal one", () => {
    // "FICSMAS Gift" (FICSMAS Gift Tree, no inputs) is cost depth 0, cheaper
    // than "Iron Ingot" (Smelter, cost depth 1) — but seasonal-last is now
    // the outermost key, so it still sorts after every normal recipe.
    const sorted = sortRecipesForChooser(defaultGameData, defaultGameData.recipes);
    const ficsmasGiftIndex = sorted.findIndex((r) => r.name === "FICSMAS Gift");
    const ironIngotIndex = sorted.findIndex((r) => r.name === "Iron Ingot");
    expect(ficsmasGiftIndex).toBeGreaterThan(-1);
    expect(ironIngotIndex).toBeGreaterThan(-1);
    expect(ironIngotIndex).toBeLessThan(ficsmasGiftIndex);
  });

  it("still orders recipes within the seasonal group by the same cost/alternate/tier/machine/name keys", () => {
    // "FICSMAS Gift" (cost depth 0) and "Blue FICSMAS Ornament" (Smelter,
    // consumes Copper Ingot which is itself cost depth 1, so Blue FICSMAS
    // Ornament is cost depth 2) are both seasonal — cost still orders them
    // relative to EACH OTHER, it just no longer competes with the
    // non-seasonal group at all.
    const sorted = sortRecipesForChooser(defaultGameData, defaultGameData.recipes);
    const giftIndex = sorted.findIndex((r) => r.name === "FICSMAS Gift");
    const ornamentIndex = sorted.findIndex((r) => r.name === "Blue FICSMAS Ornament");
    expect(giftIndex).toBeGreaterThan(-1);
    expect(ornamentIndex).toBeGreaterThan(-1);
    expect(giftIndex).toBeLessThan(ornamentIndex);
  });

  it("breaks a cost-depth tie by seasonal-last before considering alternate/tier/machine/name", () => {
    // Same base recipe (same cost-depth bucket via the fallback "unresolved"
    // cost for a synthetic name), differing ONLY in `ficsmas` — isolates it
    // as the top-priority key, ahead of everything after it.
    const seasonal: Recipe = { ...base, name: "Test Seasonal Recipe", ficsmas: true };
    const standard: Recipe = { ...base, name: "Test Standard Recipe", ficsmas: false };
    const sorted = sortRecipesForChooser(defaultGameData, [seasonal, standard]);
    expect(sorted.map((r) => r.name)).toEqual(["Test Standard Recipe", "Test Seasonal Recipe"]);
  });

  it("sorts a standard recipe before an alternate at the same cost depth, even when the alternate's own Tier is lower", () => {
    // "Basic Iron Ingot" (Foundry, alternate) consumes Iron Ore + Limestone,
    // both cost-depth-0 Miner recipes — landing at the SAME cost depth (1)
    // as standard "Iron Ingot" despite its own Tier (3-3) being far higher
    // than Iron Ingot's (0-0). Standard-before-alternate must still win.
    const sorted = sortRecipesForChooser(defaultGameData, defaultGameData.recipes);
    const standardIndex = sorted.findIndex((r) => r.name === "Iron Ingot");
    const alternateIndex = sorted.findIndex((r) => r.name === "Basic Iron Ingot");
    expect(standardIndex).toBeGreaterThan(-1);
    expect(alternateIndex).toBeGreaterThan(-1);
    expect(standardIndex).toBeLessThan(alternateIndex);
  });

  it("breaks a cost/alternate/tier tie by machine unlock order (Smelter before Constructor)", () => {
    // Neither synthetic name exists in `defaultGameData`, so both fall back
    // to the same "unresolved" cost depth — a real tie all the way down to
    // the machine key, isolating it from the other four.
    const smelterRecipe: Recipe = { ...base, name: "Test Smelter Recipe", machine: "Smelter" };
    const constructorRecipe: Recipe = { ...base, name: "Test Constructor Recipe", machine: "Constructor" };
    const sorted = sortRecipesForChooser(defaultGameData, [constructorRecipe, smelterRecipe]);
    expect(sorted.map((r) => r.name)).toEqual(["Test Smelter Recipe", "Test Constructor Recipe"]);
  });

  it("falls back to alphabetical name as the final tiebreaker", () => {
    const zRecipe: Recipe = { ...base, name: "Zzz Test Recipe" };
    const aRecipe: Recipe = { ...base, name: "Aaa Test Recipe" };
    const sorted = sortRecipesForChooser(defaultGameData, [zRecipe, aRecipe]);
    expect(sorted.map((r) => r.name)).toEqual(["Aaa Test Recipe", "Zzz Test Recipe"]);
  });

  it("doesn't mutate its input array", () => {
    const input = [defaultGameData.recipesByName.get("Iron Ingot")!, defaultGameData.recipesByName.get("Iron Ore")!];
    const original = [...input];
    sortRecipesForChooser(defaultGameData, input);
    expect(input).toEqual(original);
  });
});

describe("matchingHandleId", () => {
  it("finds the opposite-direction handle for a recipe that has the pending part", () => {
    const recipe = gameData.recipesByName.get("Iron Ingot")!;
    const handleId = matchingHandleId(recipe, { direction: "out", part: "Iron Ore" });
    expect(handleId).toBe("in:Iron Ore");
  });

  it("returns null when the recipe has no matching opposite-direction part", () => {
    const recipe = gameData.recipesByName.get("Iron Ingot")!;
    expect(matchingHandleId(recipe, { direction: "out", part: "Copper Ore" })).toBeNull();
    // Same-direction match doesn't count — dragging from an output needs an INPUT, not another output.
    expect(matchingHandleId(recipe, { direction: "in", part: "Iron Ore" })).toBeNull();
  });

  describe("a pending drag from a Splurger's wildcard port", () => {
    it("matches the recipe's own opposite-direction part — any part satisfies a wildcard", () => {
      const recipe = gameData.recipesByName.get("Iron Ingot")!;
      // Dragged from the Splurger's OUTPUT side -> needs an INPUT on the new node.
      expect(matchingHandleId(recipe, { direction: "out", part: WILDCARD_PART })).toBe("in:Iron Ore");
      // Dragged from the Splurger's INPUT side -> needs an OUTPUT on the new node.
      expect(matchingHandleId(recipe, { direction: "in", part: WILDCARD_PART })).toBe("out:Iron Ingot");
    });

    it("picks the largest-magnitude candidate when a recipe has more than one part in the wanted direction", () => {
      // Reinforced Iron Plate: Iron Plate -6, Screw -12 (both inputs).
      const recipe = gameData.recipesByName.get("Reinforced Iron Plate")!;
      expect(matchingHandleId(recipe, { direction: "out", part: WILDCARD_PART })).toBe("in:Screw");
    });

    it("treats a tiered Priority Splitter/Merger/Splurger port (*top/*bottom) as a wildcard too", () => {
      const recipe = gameData.recipesByName.get("Iron Ingot")!;
      expect(matchingHandleId(recipe, { direction: "out", part: WILDCARD_PART_TOP })).toBe("in:Iron Ore");
      expect(matchingHandleId(recipe, { direction: "out", part: WILDCARD_PART_BOTTOM })).toBe("in:Iron Ore");
    });

    it("returns null when the recipe has no part at all in the wanted direction", () => {
      // A pure generator recipe has no positive (output) part.
      const generator = gameData.recipes.find((r) => r.isGenerator)!;
      expect(matchingHandleId(generator, { direction: "in", part: WILDCARD_PART })).toBeNull();
    });
  });
});
