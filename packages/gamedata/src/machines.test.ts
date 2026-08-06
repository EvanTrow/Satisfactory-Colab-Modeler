import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { equals, of } from "@scm/rational";
import { loadGameData } from "./load";
import {
  MULTI_MACHINE_RECIPE_NAMES,
  baseRecipeRatePerMinute,
  defaultVariant,
  findVariant,
  multiMachineRecipeRatePerMinute,
  resolveMachine,
  type ResolvedMultiMachine,
} from "./machines";
import type { GameData } from "./types";

const GAME_DATA_PATH = fileURLToPath(
  new URL("../../../resources/game_data/game_data.json", import.meta.url),
);

let gameData: GameData;
beforeAll(() => {
  gameData = loadGameData(JSON.parse(readFileSync(GAME_DATA_PATH, "utf-8")));
});

describe("resolveMachine — MultiMachine resolution", () => {
  it("resolves all five special-cased names to MultiMachines", () => {
    for (const name of MULTI_MACHINE_RECIPE_NAMES) {
      const resolved = resolveMachine(name, gameData);
      expect(resolved.kind).toBe("multiMachine");
    }
  });

  it("resolves every other machine referenced by a recipe to a plain Machine", () => {
    const recipeMachineNames = new Set(gameData.recipes.map((r) => r.machine));
    const plainNames = [...recipeMachineNames].filter(
      (name) => !MULTI_MACHINE_RECIPE_NAMES.has(name),
    );
    // 24 distinct machine names appear across all recipes; 5 are MultiMachine
    // special cases, so 19 should resolve as plain machines.
    expect(plainNames).toHaveLength(19);
    for (const name of plainNames) {
      const resolved = resolveMachine(name, gameData);
      expect(resolved.kind).toBe("machine");
      if (resolved.kind === "machine") {
        expect(resolved.machine.name).toBe(name);
      }
    }
  });

  it("throws for a name not present in either Machines or MultiMachines", () => {
    expect(() => resolveMachine("Not A Real Machine", gameData)).toThrow();
  });

  it("Miner crosses 3 models × 3 capacities into 9 variants", () => {
    const resolved = resolveMachine("Miner", gameData) as ResolvedMultiMachine;
    expect(resolved.variants).toHaveLength(9);
    expect(resolved.multiMachine.ratioKind).toBe("parts");
  });

  it("Oil Extractor has no model list, only 3 capacity variants", () => {
    const resolved = resolveMachine("Oil Extractor", gameData) as ResolvedMultiMachine;
    expect(resolved.variants).toHaveLength(3);
    for (const variant of resolved.variants) {
      expect(variant.model).toBeUndefined();
      expect(variant.machine.name).toBe("Oil Extractor");
    }
  });

  it("Geothermal Generator scales PowerRatio, not PartsRatio", () => {
    const resolved = resolveMachine("Geothermal Generator", gameData) as ResolvedMultiMachine;
    expect(resolved.multiMachine.ratioKind).toBe("power");
    const pure = findVariant(resolved, { capacity: "Pure" });
    expect(pure).toBeDefined();
    expect(equals(pure!.ratio, of(2))).toBe(true);
    expect(pure!.capacity?.powerRatio).toBeDefined();
    expect(pure!.capacity?.partsRatio).toBeUndefined();
  });

  it("Space Elevator resolves to a single trivial variant (no models, no capacities)", () => {
    const resolved = resolveMachine("Space Elevator", gameData) as ResolvedMultiMachine;
    expect(resolved.variants).toHaveLength(1);
    expect(resolved.multiMachine.ratioKind).toBe("none");
    expect(equals(resolved.variants[0]!.ratio, of(1))).toBe(true);
    expect(resolved.variants[0]!.machine.name).toBe("Space Elevator");
  });

  it("Resource Well Extractor has no model list, only capacities", () => {
    const resolved = resolveMachine("Resource Well Extractor", gameData) as ResolvedMultiMachine;
    expect(resolved.variants).toHaveLength(3);
    expect(resolved.multiMachine.ratioKind).toBe("parts");
  });

  it("AWESOME Sink and Dimensional Depot Uploader are MultiMachines but resolve as plain machines (no recipe ever names them)", () => {
    for (const name of ["AWESOME Sink", "Dimensional Depot Uploader"]) {
      expect(MULTI_MACHINE_RECIPE_NAMES.has(name)).toBe(false);
      const resolved = resolveMachine(name, gameData);
      expect(resolved.kind).toBe("machine");
    }
  });

  it("defaultVariant picks the Default: true model and capacity", () => {
    const resolved = resolveMachine("Miner", gameData) as ResolvedMultiMachine;
    const def = defaultVariant(resolved);
    expect(def?.model?.name).toBe("Miner Mk.1");
    expect(def?.capacity?.name).toBe("Normal");
  });
});

describe("golden values (PLAN.md §1 / §9)", () => {
  it("Miner Mk.3 on a Pure node = 480/min, exactly", () => {
    const resolved = resolveMachine("Miner", gameData) as ResolvedMultiMachine;
    const variant = findVariant(resolved, { model: "Miner Mk.3", capacity: "Pure" });
    expect(variant).toBeDefined();
    expect(equals(variant!.ratio, of(480))).toBe(true);

    const ironOreRecipe = gameData.recipesByName.get("Iron Ore");
    expect(ironOreRecipe).toBeDefined();
    expect(equals(baseRecipeRatePerMinute(ironOreRecipe!, "Iron Ore"), of(1))).toBe(true);

    const rate = multiMachineRecipeRatePerMinute(ironOreRecipe!, "Iron Ore", variant!);
    expect(equals(rate, of(480))).toBe(true);
    // Also true for every one of the ten Miner recipes (Limestone, Copper Ore, ...).
    for (const recipe of gameData.recipesByMachine.get("Miner") ?? []) {
      const part = recipe.parts[0]!.part;
      expect(equals(multiMachineRecipeRatePerMinute(recipe, part, variant!), of(480))).toBe(true);
    }
  });

  it("Miner Mk.1 on Normal (all defaults) = 60/min", () => {
    const resolved = resolveMachine("Miner", gameData) as ResolvedMultiMachine;
    const variant = defaultVariant(resolved)!;
    const recipe = gameData.recipesByName.get("Iron Ore")!;
    const rate = multiMachineRecipeRatePerMinute(recipe, "Iron Ore", variant);
    expect(equals(rate, of(60))).toBe(true);
  });
});
