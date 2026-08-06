import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGameData } from "./load";
import { iconFileName, verifyIconCoverage } from "./icons";

const GAME_DATA_PATH = fileURLToPath(
  new URL("../../../resources/game_data/game_data.json", import.meta.url),
);
const ICONS_DIR = fileURLToPath(new URL("../../../resources/images/icons", import.meta.url));

describe("iconFileName", () => {
  it("replaces spaces with underscores and appends .png", () => {
    expect(iconFileName("Iron Ore")).toBe("Iron_Ore.png");
    expect(iconFileName("Smelter")).toBe("Smelter.png");
    expect(iconFileName("Heavy Modular Frame")).toBe("Heavy_Modular_Frame.png");
  });
});

describe("verifyIconCoverage against the real resources/images/icons directory", () => {
  it("every part and machine resolves to an existing file, with no unexplained orphans (PLAN.md §1: 170 + 32 + 2 = 204)", () => {
    const gameData = loadGameData(JSON.parse(readFileSync(GAME_DATA_PATH, "utf-8")));
    const availableFiles = readdirSync(ICONS_DIR);

    expect(availableFiles).toHaveLength(204);

    const result = verifyIconCoverage(gameData, availableFiles);
    expect(result.missing).toEqual([]);
    expect(result.orphans).toEqual([]);
    expect(result.isComplete).toBe(true);
  });

  it("reports the two documented logistics icons as orphans when they aren't in the allowlist", () => {
    const gameData = loadGameData(JSON.parse(readFileSync(GAME_DATA_PATH, "utf-8")));
    const availableFiles = readdirSync(ICONS_DIR);

    const result = verifyIconCoverage(gameData, availableFiles, []);
    expect(result.orphans).toEqual(["Conveyor_Merger.png", "Smart_Splitter.png"]);
    expect(result.isComplete).toBe(false);
  });

  it("reports a missing file when a part/machine has no icon", () => {
    const gameData = loadGameData(JSON.parse(readFileSync(GAME_DATA_PATH, "utf-8")));
    const availableFiles = readdirSync(ICONS_DIR).filter((f) => f !== "Iron_Ore.png");

    const result = verifyIconCoverage(gameData, availableFiles);
    expect(result.missing).toEqual(["Iron_Ore.png"]);
    expect(result.isComplete).toBe(false);
  });
});
