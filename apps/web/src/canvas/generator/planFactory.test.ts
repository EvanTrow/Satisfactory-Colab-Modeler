import { defaultGameData } from "@scm/gamedata";
import { equals, of } from "@scm/rational";
import { describe, expect, it } from "vitest";

import { layoutFactoryPlan, planFactory, type PlannedNode } from "./planFactory";

const gameData = defaultGameData;

function machineCount(nodes: readonly PlannedNode[], part: string) {
  return nodes.find((n) => n.part === part)?.machineCount;
}

describe("planFactory", () => {
  it("plans a two-step chain (Iron Ingot <- Iron Ore) with exact machine counts", () => {
    // Iron Ingot: Smelter, -1 Iron Ore / +1 Iron Ingot per 2s -> 30/min per
    // machine. Iron Ore: Miner Mk.1 x Normal (the default variant) -> 60/min
    // per machine. Neither part has a cheaper alternate/converter route (see
    // this file's own header note on `Cast Screw` for a case where one
    // does), so both resolve to their plain, non-alternate recipe.
    const plan = planFactory(gameData, "Iron Ingot", of(60));

    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.map((n) => n.part).sort()).toEqual(["Iron Ingot", "Iron Ore"]);
    expect(plan.nodes.find((n) => n.part === "Iron Ingot")?.recipe.name).toBe("Iron Ingot");
    expect(plan.nodes.find((n) => n.part === "Iron Ore")?.recipe.name).toBe("Iron Ore");

    expect(equals(machineCount(plan.nodes, "Iron Ingot")!, of(2))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Iron Ore")!, of(1))).toBe(true);

    expect(plan.edges).toEqual([{ part: "Iron Ore", fromPart: "Iron Ore", toPart: "Iron Ingot" }]);

    const ironOre = plan.nodes.find((n) => n.part === "Iron Ore")!;
    const ironIngot = plan.nodes.find((n) => n.part === "Iron Ingot")!;
    expect(ironOre.generation).toBe(0);
    expect(ironIngot.generation).toBe(1);
  });

  it("aggregates demand across two different consumers of the same intermediate part (a diamond dependency)", () => {
    // Rotor (Assembler) needs Iron Rod directly AND Screw. `sortRecipesForChooser`'s
    // cost-depth-first ordering picks "Cast Screw" (an ALTERNATE recipe,
    // Iron Ingot -> Screw directly) over the plain Iron-Rod-based "Screw"
    // recipe, because it's cheaper (cost 2 vs. cost 3) — cost-depth outranks
    // "prefer standard" in the sort. That makes both of Rotor's own inputs
    // bottom out at Iron Ingot, which is exactly the fan-out this test
    // exercises: ONE Iron Ingot producer feeding TWO separate consumers
    // (Iron Rod's recipe and Cast Screw's recipe), each contributing its own
    // share of Iron Ingot demand.
    const plan = planFactory(gameData, "Rotor", of(4)); // 4/min = exactly 1 Rotor machine

    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.map((n) => n.part).sort()).toEqual(
      ["Iron Ingot", "Iron Ore", "Iron Rod", "Rotor", "Screw"].sort(),
    );
    expect(plan.nodes.find((n) => n.part === "Screw")?.recipe.name).toBe("Cast Screw");
    expect(plan.nodes.find((n) => n.part === "Iron Rod")?.recipe.name).toBe("Iron Rod");

    expect(equals(machineCount(plan.nodes, "Rotor")!, of(1))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Iron Rod")!, of(4, 3))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Screw")!, of(2))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Iron Ingot")!, of(3, 2))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Iron Ore")!, of(3, 4))).toBe(true);

    // Fan-out: Iron Ingot's producer feeds both Iron Rod and Screw.
    const fromIronIngot = plan.edges.filter((e) => e.fromPart === "Iron Ingot");
    expect(fromIronIngot.map((e) => e.toPart).sort()).toEqual(["Iron Rod", "Screw"]);
    expect(plan.edges).toHaveLength(5);

    // Layered generations: Iron Ore (0) -> Iron Ingot (1) -> {Iron Rod, Screw} (2) -> Rotor (3).
    const gen = (part: string) => plan.nodes.find((n) => n.part === part)!.generation;
    expect(gen("Iron Ore")).toBe(0);
    expect(gen("Iron Ingot")).toBe(1);
    expect(gen("Iron Rod")).toBe(2);
    expect(gen("Screw")).toBe(2);
    expect(gen("Rotor")).toBe(3);
  });

  it("reports a target part with no producing recipe as unresolved instead of throwing", () => {
    const plan = planFactory(gameData, "Not A Real Part", of(60));
    expect(plan.unresolvedParts).toEqual(["Not A Real Part"]);
    expect(plan.nodes).toEqual([]);
    expect(plan.edges).toEqual([]);
  });
});

describe("layoutFactoryPlan", () => {
  it("places each generation in its own column and stacks a column's nodes without overlap", () => {
    const plan = planFactory(gameData, "Rotor", of(4));
    const positions = layoutFactoryPlan(plan, { basePosition: { x: 100, y: 200 } });

    expect(positions.size).toBe(plan.nodes.length);

    const xByPart = new Map(plan.nodes.map((n) => [n.part, positions.get(n.part)!.x]));
    // Column x is a pure function of generation, and strictly increases with it.
    expect(xByPart.get("Iron Ore")).toBe(100);
    expect(xByPart.get("Iron Ingot")).toBe(100 + 340);
    expect(xByPart.get("Iron Rod")).toBe(100 + 340 * 2);
    expect(xByPart.get("Screw")).toBe(100 + 340 * 2);
    expect(xByPart.get("Rotor")).toBe(100 + 340 * 3);

    // Iron Rod and Screw share a column (generation 2) — they must not
    // overlap vertically, and every position must clear the >=200 base.
    const ironRodY = positions.get("Iron Rod")!.y;
    const screwY = positions.get("Screw")!.y;
    expect(ironRodY).not.toBe(screwY);
    expect(Math.min(ironRodY, screwY)).toBeGreaterThanOrEqual(200);
    expect(Math.abs(ironRodY - screwY)).toBeGreaterThan(100); // at least a full card's worth of clearance
  });
});
