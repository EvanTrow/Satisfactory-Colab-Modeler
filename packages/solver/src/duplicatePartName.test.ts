// Regression coverage for a real game-data shape that broke rate lookups
// keyed by bare part name: a handful of recipes (Encased Uranium Cell,
// Distilled Silica, Instant Scrap) list the SAME part name twice — once as
// a consumed input, once as a partial-recycle byproduct output. Before this
// fix, every rate lookup that took just a part name (`recipe.parts.find`)
// silently returned whichever entry came first, so the byproduct entry's
// own rate was never actually computed anywhere — see `nodeProfile.ts`'s
// `refRatePerPartByDirection` and `nodeResult.ts`'s `partRateKey` for the
// fix itself.
import { defaultGameData, type RecipePart } from "@scm/gamedata";
import { divide, equals, isNegative, isPositive, multiply, of, parseRational } from "@scm/rational";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverSnapshot } from "./snapshot";

const DUPLICATE_PART_RECIPES = [
  { recipeName: "Encased Uranium Cell", duplicatePart: "Sulfuric Acid" },
  { recipeName: "Distilled Silica", duplicatePart: "Water" },
  { recipeName: "Instant Scrap", duplicatePart: "Water" },
];

function solveSingleNode(recipeName: string, machine: string, machineCount: string) {
  const snapshot: SolverSnapshot = {
    nodes: [
      {
        id: "n1",
        recipe: recipeName,
        machine,
        purity: null,
        limit: machineCount,
        limitMode: "machines",
        clock: null,
        shards: 0,
      },
    ],
    edges: [],
  };
  const result = solve(snapshot, "manual", defaultGameData);
  return result.nodes.find((n) => n.nodeId === "n1")!;
}

describe.each(DUPLICATE_PART_RECIPES)(
  "$recipeName: the input and byproduct $duplicatePart entries",
  ({ recipeName, duplicatePart }) => {
    const recipe = defaultGameData.recipesByName.get(recipeName);
    if (!recipe) throw new Error(`fixture recipe "${recipeName}" missing from @scm/gamedata`);

    const duplicateEntries = recipe.parts.filter((p) => p.part === duplicatePart);
    const inputEntry = duplicateEntries.find((p) => isNegative(p.amount)) as RecipePart;
    const outputEntry = duplicateEntries.find((p) => isPositive(p.amount)) as RecipePart;

    it("really does list the part twice in the game data (documents the shape this test guards)", () => {
      expect(duplicateEntries).toHaveLength(2);
      expect(inputEntry).toBeDefined();
      expect(outputEntry).toBeDefined();
    });

    it("reports distinct, correct rates for the input and byproduct entries via partRatesByDirection", () => {
      const node = solveSingleNode(recipeName, recipe.machine, "2");
      expect(node.valid).toBe(true);

      const inputRate = parseRational(node.partRatesByDirection![`in:${duplicatePart}`]!);
      const outputRate = parseRational(node.partRatesByDirection![`out:${duplicatePart}`]!);

      // The two entries must never collapse to the same value or sign.
      expect(isNegative(inputRate)).toBe(true);
      expect(isPositive(outputRate)).toBe(true);
      expect(equals(inputRate, outputRate)).toBe(false);

      // Each disambiguated rate matches machineCount × that SPECIFIC
      // entry's own (amount / batchTime × 60) — computed independently
      // from the raw recipe data, not hand-copied numbers, so this stays
      // correct if the underlying game data ever changes. Plain (non-
      // MultiMachine) recipe, so no ratio/variant multiplier applies.
      const machineCount = parseRational(node.machineCount);
      const perMinute = (entry: RecipePart) =>
        multiply(multiply(divide(entry.amount, recipe.batchTime), of(60)), machineCount);

      expect(equals(inputRate, perMinute(inputEntry))).toBe(true);
      expect(equals(outputRate, perMinute(outputEntry))).toBe(true);
    });

    it("still exposes SOME rate under the bare (non-prefixed) key, for backward-compatible aggregate consumers", () => {
      const node = solveSingleNode(recipeName, recipe.machine, "1");
      expect(node.partRates[duplicatePart]).toBeDefined();
    });
  },
);
