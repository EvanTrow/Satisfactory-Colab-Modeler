// A small, hand-built `GameData` fixture (via `@scm/gamedata`'s
// `loadGameData`, same mechanism `packages/gamedata/src/load.test.ts` uses
// against the real file) rather than `defaultGameData` — the real 332-recipe
// dataset has enough alternates competing for "Iron Ingot" (e.g. "Leached
// Iron ingot", which routes through Sulfuric Acid) that hand-deriving the
// TRUE winner under every priority means recursing through chains this
// module doesn't otherwise need to know about. A minimal, fully-controlled
// fixture keeps every weight below verifiable by hand in the test itself.
import { loadGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";

import { createRecipeSelector, type GenerationPriority } from "./recipePriority";

// Two raw materials (Ore, Rare Ore), each a plain 60/min extraction recipe
// at -2 MW. Two competing recipes for Ingot:
//   - "Ingot" (standard): Smelter, -1 Ore -> +1 Ingot per 2s = 30/min, -4 MW.
//   - "Ingot Alt" (alternate): BigFoundry, -4 Ore -1 Rare Ore -> +10 Ingot
//     per 4s = 150/min, -40 MW.
// Both have the same cost-DEPTH (1 production step above raw materials), so
// "balanced" ties and falls back to preferring the standard recipe — but the
// other four priorities each weigh the ACTUAL numbers differently:
//   - fewestMachines:      Alt needs far fewer machines per unit/min (higher yield).
//   - fewestRawResources:  Alt turns 5 combined ore into 10 ingots vs. 1-for-1.
//   - simplestChain:       Standard has 1 input; Alt has 2 -> Standard wins.
//   - lowestPower:         BigFoundry's -40 MW outweighs Alt's throughput edge.
const gameData = loadGameData({
  Machines: [
    { Name: "Extractor", Tier: "0-0", AveragePower: "-2" },
    { Name: "Smelter", Tier: "0-0", AveragePower: "-4" },
    { Name: "BigFoundry", Tier: "0-0", AveragePower: "-40" },
  ],
  MultiMachines: [],
  Parts: [
    { Name: "Ore", Tier: "0-0", SinkPoints: 0 },
    { Name: "Rare Ore", Tier: "0-0", SinkPoints: 0 },
    { Name: "Ingot", Tier: "0-0", SinkPoints: 0 },
  ],
  Recipes: [
    { Name: "Ore", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "Ore", Amount: "60" }] },
    {
      Name: "Rare Ore",
      Machine: "Extractor",
      BatchTime: "60",
      Tier: "0-0",
      Parts: [{ Part: "Rare Ore", Amount: "60" }],
    },
    {
      Name: "Ingot",
      Machine: "Smelter",
      BatchTime: "2",
      Tier: "0-0",
      Parts: [
        { Part: "Ore", Amount: "-1" },
        { Part: "Ingot", Amount: "1" },
      ],
    },
    {
      Name: "Ingot Alt",
      Machine: "BigFoundry",
      BatchTime: "4",
      Tier: "0-0",
      Alternate: true,
      Parts: [
        { Part: "Ore", Amount: "-4" },
        { Part: "Rare Ore", Amount: "-1" },
        { Part: "Ingot", Amount: "10" },
      ],
    },
  ],
});

function pickFor(priority: GenerationPriority, disabled: readonly string[] = []): string | undefined {
  const candidates = (gameData.recipesByPartAsOutput.get("Ingot") ?? []).filter(
    (r) => !disabled.includes(r.name),
  );
  return createRecipeSelector(gameData, priority, new Set(disabled)).pick("Ingot", candidates)?.name;
}

describe("createRecipeSelector", () => {
  it("balanced ties on cost-depth (both are 1 step above raw materials) and prefers the standard recipe", () => {
    expect(pickFor("balanced")).toBe("Ingot");
  });

  it("fewestMachines prefers Ingot Alt: weight 3/200 (0.015) vs. 1/20 (0.05) for the standard recipe", () => {
    expect(pickFor("fewestMachines")).toBe("Ingot Alt");
  });

  it("fewestRawResources prefers Ingot Alt: weight 1/2 (10 ingots from 5 combined ore) vs. 1 (1-for-1)", () => {
    expect(pickFor("fewestRawResources")).toBe("Ingot Alt");
  });

  it("simplestChain prefers standard Ingot: weight 2 (one input) vs. 3 (two inputs) for the alternate", () => {
    expect(pickFor("simplestChain")).toBe("Ingot");
  });

  it("lowestPower prefers standard Ingot: BigFoundry's -40 MW outweighs Ingot Alt's higher yield", () => {
    expect(pickFor("lowestPower")).toBe("Ingot");
  });

  it("respects disabledRecipes even inside the relaxation, not just the top-level candidate filter", () => {
    // With the alternate disabled, fewestMachines has nothing but the
    // standard recipe left to relax toward.
    expect(pickFor("fewestMachines", ["Ingot Alt"])).toBe("Ingot");
  });
});
