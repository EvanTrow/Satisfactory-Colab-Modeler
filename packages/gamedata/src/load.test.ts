import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { equals, isNegative, isPositive, of } from "@scm/rational";
import { GAME_DATA_VERSION, loadGameData } from "./load";

const GAME_DATA_PATH = fileURLToPath(
  new URL("../../../resources/game_data/game_data.json", import.meta.url),
);

function readRealGameDataJson(): unknown {
  return JSON.parse(readFileSync(GAME_DATA_PATH, "utf-8"));
}

describe("loadGameData", () => {
  it("parses the real resources/game_data/game_data.json with zero validation errors", () => {
    expect(() => loadGameData(readRealGameDataJson())).not.toThrow();
  });

  it("produces the expected entity counts (PLAN.md §1: 32 machines, 7 multi-machines, 170 parts, 332 recipes)", () => {
    const gameData = loadGameData(readRealGameDataJson());
    expect(gameData.machines).toHaveLength(32);
    expect(gameData.multiMachines).toHaveLength(7);
    expect(gameData.parts).toHaveLength(170);
    expect(gameData.recipes).toHaveLength(332);
  });

  it("converts every numeric string field to an exact Rational, never a raw string or number", () => {
    const gameData = loadGameData(readRealGameDataJson());

    const smelter = gameData.machinesByName.get("Smelter");
    expect(smelter).toBeDefined();
    expect(typeof smelter?.averagePower).toBe("object");
    expect(equals(smelter!.averagePower!, of(-4))).toBe(true);
    expect(equals(smelter!.cost[0]!.amount, of(5))).toBe(true);

    const ironIngotRecipe = gameData.recipesByName.get("Iron Ingot");
    expect(ironIngotRecipe).toBeDefined();
    expect(equals(ironIngotRecipe!.batchTime, of(2))).toBe(true);
  });

  it("keeps OverclockPowerExponent as the one deliberate `number` float boundary", () => {
    const gameData = loadGameData(readRealGameDataJson());
    const smelter = gameData.machinesByName.get("Smelter");
    expect(typeof smelter?.overclockPowerExponent).toBe("number");
    expect(smelter?.overclockPowerExponent).toBeCloseTo(1.321929, 6);
  });

  it('treats MultiMachine.DefaultMax `""` as undefined rather than failing to parse', () => {
    const gameData = loadGameData(readRealGameDataJson());
    const awesomeSink = gameData.multiMachinesByName.get("AWESOME Sink");
    expect(awesomeSink).toBeDefined();
    expect(awesomeSink?.defaultMax).toBeUndefined();

    const miner = gameData.multiMachinesByName.get("Miner");
    expect(miner?.defaultMax).toBeDefined();
    expect(equals(miner!.defaultMax!, of(60))).toBe(true);
  });

  it("sets Recipe.isGenerator for exactly the 23 recipes with no positive-amount part (PLAN.md §1)", () => {
    const gameData = loadGameData(readRealGameDataJson());
    expect(gameData.generatorRecipes).toHaveLength(23);
    for (const recipe of gameData.generatorRecipes) {
      expect(recipe.parts.every((p) => !isPositive(p.amount))).toBe(true);
    }
  });

  it("applies the AveragePower sign convention: positive generates, negative consumes", () => {
    const gameData = loadGameData(readRealGameDataJson());
    const nuclear = gameData.machinesByName.get("Nuclear Power Plant");
    expect(isPositive(nuclear!.averagePower!)).toBe(true);
    expect(equals(nuclear!.averagePower!, of(2500))).toBe(true);

    const manufacturer = gameData.machinesByName.get("Manufacturer");
    expect(isNegative(manufacturer!.averagePower!)).toBe(true);
    expect(equals(manufacturer!.averagePower!, of(-55))).toBe(true);
  });

  it("throws a descriptive error on malformed input", () => {
    expect(() => loadGameData({ Machines: "not an array" })).toThrow();
    expect(() =>
      loadGameData({
        Machines: [{ Name: "Bad", Tier: "0-0", AveragePower: "not-a-rational" }],
        MultiMachines: [],
        Parts: [],
        Recipes: [],
      }),
    ).toThrow();
  });

  it("exposes a game data version identifier (no version field exists in game_data.json today)", () => {
    expect(GAME_DATA_VERSION).toBe("unversioned");
  });
});
