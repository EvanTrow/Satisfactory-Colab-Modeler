import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { equals, multiply, of } from "@scm/rational";
import { loadGameData } from "./load";
import { somersloopBoost } from "./somersloop";
import type { GameData } from "./types";

const GAME_DATA_PATH = fileURLToPath(
  new URL("../../../resources/game_data/game_data.json", import.meta.url),
);

let gameData: GameData;
beforeAll(() => {
  gameData = loadGameData(JSON.parse(readFileSync(GAME_DATA_PATH, "utf-8")));
});

describe("somersloopBoost — golden value (PLAN.md §1 / §9)", () => {
  it("Manufacturer + 4 somersloops = 2x output at 4x power", () => {
    const manufacturer = gameData.machinesByName.get("Manufacturer")!;
    expect(manufacturer.maxProductionShards).toBe(4);

    const boost = somersloopBoost(manufacturer, 4);
    expect(equals(boost.outputMultiplier, of(2))).toBe(true);
    expect(equals(boost.powerMultiplier, of(4))).toBe(true);
  });

  it("0 shards is a 1x/1x no-op for every machine that supports shards", () => {
    const manufacturer = gameData.machinesByName.get("Manufacturer")!;
    const boost = somersloopBoost(manufacturer, 0);
    expect(equals(boost.outputMultiplier, of(1))).toBe(true);
    expect(equals(boost.powerMultiplier, of(1))).toBe(true);
  });

  it("intermediate shard counts scale linearly in output, quadratically in power", () => {
    const manufacturer = gameData.machinesByName.get("Manufacturer")!;
    // 2 shards: output = 1 + 2*(1/4) = 3/2; power = (3/2)^2 = 9/4.
    const boost = somersloopBoost(manufacturer, 2);
    expect(equals(boost.outputMultiplier, of(3, 2))).toBe(true);
    expect(equals(boost.powerMultiplier, of(9, 4))).toBe(true);
  });

  it("throws when shard count exceeds the machine's MaxProductionShards", () => {
    const manufacturer = gameData.machinesByName.get("Manufacturer")!;
    expect(() => somersloopBoost(manufacturer, 5)).toThrow();
  });

  it("throws for a negative or non-integer shard count", () => {
    const manufacturer = gameData.machinesByName.get("Manufacturer")!;
    expect(() => somersloopBoost(manufacturer, -1)).toThrow();
    expect(() => somersloopBoost(manufacturer, 1.5)).toThrow();
  });

  it("a machine with no shard support (MaxProductionShards absent) rejects any nonzero shard count", () => {
    const spaceElevator = gameData.machinesByName.get("Space Elevator")!;
    expect(spaceElevator.maxProductionShards).toBeUndefined();
    expect(() => somersloopBoost(spaceElevator, 1)).toThrow();
    expect(equals(somersloopBoost(spaceElevator, 0).outputMultiplier, of(1))).toBe(true);
  });

  it("powerMultiplier == outputMultiplier^2 for every machine that supports shards, at its max (ProductionShardPowerExponent is always 2 in the current data)", () => {
    let checked = 0;
    for (const machine of gameData.machines) {
      if (!machine.maxProductionShards) continue;
      const boost = somersloopBoost(machine, machine.maxProductionShards);
      expect(boost.shards).toBe(machine.maxProductionShards);
      expect(
        equals(boost.powerMultiplier, multiply(boost.outputMultiplier, boost.outputMultiplier)),
      ).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
