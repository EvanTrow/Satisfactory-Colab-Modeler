import { describe, expect, it } from "vitest";
import { defaultGameData } from "./data";

describe("defaultGameData", () => {
  it("is the real game data, loaded and indexed at module load time", () => {
    expect(defaultGameData.machines).toHaveLength(32);
    expect(defaultGameData.multiMachines).toHaveLength(7);
    expect(defaultGameData.parts).toHaveLength(170);
    expect(defaultGameData.recipes).toHaveLength(332);
    expect(defaultGameData.machinesByName.get("Smelter")).toBeDefined();
    expect(defaultGameData.generatorRecipes).toHaveLength(23);
  });
});
