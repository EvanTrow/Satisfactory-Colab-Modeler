import { defaultGameData, loadGameData } from "@scm/gamedata";
import { equals, isZero, of } from "@scm/rational";
import { describe, expect, it } from "vitest";

import { layoutByproductDisposals, layoutFactoryPlan, planFactory, type PlannedNode } from "./planFactory";

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
    const plan = planFactory(gameData, [{ part: "Iron Ingot", rate: of(60) }]);

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
    const plan = planFactory(gameData, [{ part: "Rotor", rate: of(4) }]); // 4/min = exactly 1 Rotor machine

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
    const plan = planFactory(gameData, [{ part: "Not A Real Part", rate: of(60) }]);
    expect(plan.unresolvedParts).toEqual(["Not A Real Part"]);
    expect(plan.nodes).toEqual([]);
    expect(plan.edges).toEqual([]);
  });

  it("aggregates demand across two INDEPENDENT targets that happen to share a common intermediate", () => {
    // Iron Plate and Iron Rod are each their own target (neither consumes
    // the other) but both bottom out at Iron Ingot -> Iron Ore. This is the
    // new multi-target case: one shared Iron Ingot producer sized for both
    // targets' combined consumption, not two separate (and wrong) ones.
    const plan = planFactory(gameData, [
      { part: "Iron Plate", rate: of(20) }, // Constructor, 2 per 6s -> 20/min = exactly 1 machine
      { part: "Iron Rod", rate: of(15) }, // Constructor, 1 per 4s -> 15/min = exactly 1 machine
    ]);

    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.map((n) => n.part).sort()).toEqual(
      ["Iron Ingot", "Iron Ore", "Iron Plate", "Iron Rod"].sort(),
    );

    expect(equals(machineCount(plan.nodes, "Iron Plate")!, of(1))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Iron Rod")!, of(1))).toBe(true);
    // Iron Plate consumes 3 Iron Ingot/6s = 30/min; Iron Rod consumes 1/4s = 15/min. Combined 45/min / 30 per machine = 1.5.
    expect(equals(machineCount(plan.nodes, "Iron Ingot")!, of(3, 2))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Iron Ore")!, of(3, 4))).toBe(true);

    const fromIronIngot = plan.edges.filter((e) => e.fromPart === "Iron Ingot");
    expect(fromIronIngot.map((e) => e.toPart).sort()).toEqual(["Iron Plate", "Iron Rod"]);
  });

  it("lets a target that's ALSO an ingredient of another target's own chain wait its turn and sum both demands", () => {
    // Iron Rod is selected as its own target (a direct external demand)
    // AND is consumed by Rotor's recipe (an in-graph demand) — Iron Rod's
    // `machineCount` must reflect both, which only works if it's not
    // force-finalized before Rotor's own contribution arrives.
    const plan = planFactory(gameData, [
      { part: "Rotor", rate: of(4) }, // 1 machine; consumes 20 Iron Rod/min + 100 Screw/min
      { part: "Iron Rod", rate: of(15) }, // +1 machine's worth of DIRECT Iron Rod demand
    ]);

    expect(plan.unresolvedParts).toEqual([]);
    expect(equals(machineCount(plan.nodes, "Rotor")!, of(1))).toBe(true);
    // 20 (from Rotor) + 15 (direct target) = 35/min, / 15 per machine = 7/3.
    expect(equals(machineCount(plan.nodes, "Iron Rod")!, of(7, 3))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Screw")!, of(2))).toBe(true);
    // Iron Ingot demand: 35 (Iron Rod, 15/machine * 7/3) + 25 (Cast Screw, 12.5/machine * 2) = 60/min, / 30 = 2.
    expect(equals(machineCount(plan.nodes, "Iron Ingot")!, of(2))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Iron Ore")!, of(1))).toBe(true);

    // Iron Rod's producer feeds Rotor (as an ingredient) — a real edge, not just a target.
    expect(
      plan.edges.some((e) => e.fromPart === "Iron Rod" && e.toPart === "Rotor"),
    ).toBe(true);
  });

  it("falls back to the standard recipe when a cheaper alternate is disabled", () => {
    // Same Rotor case as above, but with "Cast Screw" disabled — Screw must
    // now fall back to the plain, standard "Screw" recipe (Iron Rod ->
    // Screw), which reshapes the whole graph: Iron Rod now feeds BOTH Rotor
    // AND Screw instead of Screw bottoming out at Iron Ingot directly.
    const plan = planFactory(gameData, [{ part: "Rotor", rate: of(4) }], {
      disabledRecipes: new Set(["Cast Screw"]),
    });

    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.find((n) => n.part === "Screw")?.recipe.name).toBe("Screw");

    expect(equals(machineCount(plan.nodes, "Rotor")!, of(1))).toBe(true);
    // Screw (standard): 4 per 6s = 40/min/machine; 100/min demand -> 2.5 machines.
    expect(equals(machineCount(plan.nodes, "Screw")!, of(5, 2))).toBe(true);
    // Iron Rod demand: 20 (direct, from Rotor) + 25 (from Screw, 10/machine * 2.5) = 45/min / 15 = 3.
    expect(equals(machineCount(plan.nodes, "Iron Rod")!, of(3))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Iron Ingot")!, of(3, 2))).toBe(true);
    expect(equals(machineCount(plan.nodes, "Iron Ore")!, of(3, 4))).toBe(true);

    // Iron Rod's producer now fans out to both Rotor and Screw.
    const fromIronRod = plan.edges.filter((e) => e.fromPart === "Iron Rod");
    expect(fromIronRod.map((e) => e.toPart).sort()).toEqual(["Rotor", "Screw"]);
  });

  it("reports a part as unresolved when every recipe that could produce it is disabled", () => {
    const allIronOreRecipes = gameData.recipesByPartAsOutput.get("Iron Ore")!.map((r) => r.name);
    const plan = planFactory(gameData, [{ part: "Iron Ore", rate: of(60) }], {
      disabledRecipes: new Set(allIronOreRecipes),
    });
    expect(plan.unresolvedParts).toEqual(["Iron Ore"]);
    expect(plan.nodes).toEqual([]);
  });
});

// Same minimal fixture `recipePriority.test.ts` hand-verifies every weight
// against — reused here (not `defaultGameData`) to prove `priority` actually
// reshapes the whole generated GRAPH end to end, not just an isolated pick,
// without the real dataset's own competing alternates (see that file's
// header) muddying which recipe "should" win.
const priorityFixture = loadGameData({
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

describe("planFactory priority option", () => {
  it("defaults to balanced (the standard recipe) when no priority is given", () => {
    const plan = planFactory(priorityFixture, [{ part: "Ingot", rate: of(30) }]);
    expect(plan.nodes.find((n) => n.part === "Ingot")?.recipe.name).toBe("Ingot");
    expect(plan.nodes.map((n) => n.part).sort()).toEqual(["Ingot", "Ore"]);
  });

  it("switches the whole graph to the alternate recipe under fewestMachines, pulling in its Rare Ore input", () => {
    const plan = planFactory(priorityFixture, [{ part: "Ingot", rate: of(150) }], { priority: "fewestMachines" });
    expect(plan.nodes.find((n) => n.part === "Ingot")?.recipe.name).toBe("Ingot Alt");
    expect(plan.nodes.map((n) => n.part).sort()).toEqual(["Ingot", "Ore", "Rare Ore"]);

    expect(equals(machineCount(plan.nodes, "Ingot")!, of(1))).toBe(true); // 150/min = exactly 1 BigFoundry
    expect(equals(machineCount(plan.nodes, "Ore")!, of(1))).toBe(true); // 60/min consumed / 60/min per machine
    expect(equals(machineCount(plan.nodes, "Rare Ore")!, of(1, 4))).toBe(true); // 15/min consumed / 60/min per machine
  });
});

// Regression coverage for a real bug: a rate-weighted priority (unlike
// "balanced"'s cost-depth ordering) has no built-in guarantee against
// picking a MUTUALLY self-referential pair of recipes — the real-game
// example is "Recycled Plastic" (Rubber + Fuel -> Plastic) and "Recycled
// Rubber" (Plastic + Fuel -> Rubber), each of which can look like the
// cheapest way to produce its own part once the other's weight is known.
// Picking both simultaneously is a genuine cycle a topological demand pass
// can never finish over — before the fix, this silently produced 0-machine
// nodes for everything downstream of the cycle instead of failing loudly.
describe("planFactory cycle avoidance", () => {
  // Two symmetric "byproduct loop" parts (A, B): each has a standard,
  // Filler-only recipe (S = 1.5 combined-Filler-per-unit, deliberately
  // inefficient, mirroring the real Plastic/Rubber standard recipes' 3
  // Crude Oil -> 2 output ratio) and an alternate that converts the OTHER
  // part (plus Filler) back into itself at a much better ratio. Under
  // "fewestRawResources", the alternate pair's mutual fixed-point weight is
  // exactly 1 (< the standard's 1.5), so — before the fix — BOTH parts would
  // pick their alternate, forming a cycle.
  const loopFixture = loadGameData({
    Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
    MultiMachines: [],
    Parts: [
      { Name: "Filler", Tier: "0-0", SinkPoints: 0 },
      { Name: "A", Tier: "0-0", SinkPoints: 0 },
      { Name: "B", Tier: "0-0", SinkPoints: 0 },
    ],
    Recipes: [
      {
        Name: "Filler",
        Machine: "Extractor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [{ Part: "Filler", Amount: "60" }],
      },
      {
        Name: "A",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "Filler", Amount: "-3" },
          { Part: "A", Amount: "2" },
        ],
      },
      {
        Name: "B",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "Filler", Amount: "-3" },
          { Part: "B", Amount: "2" },
        ],
      },
      {
        Name: "Alt A",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Alternate: true,
        Parts: [
          { Part: "B", Amount: "-6" },
          { Part: "Filler", Amount: "-6" },
          { Part: "A", Amount: "12" },
        ],
      },
      {
        Name: "Alt B",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Alternate: true,
        Parts: [
          { Part: "A", Amount: "-6" },
          { Part: "Filler", Amount: "-6" },
          { Part: "B", Amount: "12" },
        ],
      },
    ],
  });

  it("breaks a two-recipe byproduct loop by falling back to the standard recipe on one side", () => {
    const plan = planFactory(loopFixture, [{ part: "A", rate: of(12) }], { priority: "fewestRawResources" });

    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.some((n) => isZero(n.machineCount))).toBe(false);

    // A keeps its cheaper alternate; B is forced back to its standard
    // recipe (Filler only) once the cycle check disqualifies "Alt B" —
    // whichever part is resolved SECOND in the DFS is the one that has to
    // give way, since the first part's choice is already locked in by the
    // time the cycle is detected one level deeper.
    expect(plan.nodes.find((n) => n.part === "A")?.recipe.name).toBe("Alt A");
    expect(plan.nodes.find((n) => n.part === "B")?.recipe.name).toBe("B");

    expect(equals(machineCount(plan.nodes, "A")!, of(1))).toBe(true); // 12/min = exactly 1 "Alt A" machine
    expect(equals(machineCount(plan.nodes, "B")!, of(3))).toBe(true); // 6/min demand / 2 per machine
    expect(equals(machineCount(plan.nodes, "Filler")!, of(1, 4))).toBe(true); // (6 + 9)/min demand / 60 per machine

    // Acyclic: Filler -> B -> A, plus Filler -> A directly.
    expect(plan.edges.map((e) => `${e.fromPart}->${e.toPart}`).sort()).toEqual(
      ["B->A", "Filler->A", "Filler->B"].sort(),
    );
  });

  it("reports a part as unresolved (not a silently-wrong plan) when literally every candidate closes a cycle", () => {
    // Same loop, but with BOTH standard recipes disabled — "Alt A" and
    // "Alt B" are each other's only remaining candidate, so whichever part
    // is resolved second has no acyclic escape at all.
    const plan = planFactory(loopFixture, [{ part: "A", rate: of(12) }], {
      priority: "fewestRawResources",
      disabledRecipes: new Set(["A", "B"]),
    });

    expect(plan.unresolvedParts).toEqual(["B"]);
    expect(plan.nodes.find((n) => n.part === "A")?.recipe.name).toBe("Alt A");
    expect(plan.nodes.some((n) => n.part === "B")).toBe(false);
    // B's port on A's node is simply left unconnected rather than crashing or looping forever.
    expect(plan.edges.some((e) => e.toPart === "A" && e.part === "B")).toBe(false);
  });

  it("real-data regression: Adaptive Control Unit under fewestRawResources no longer breaks on the real Recycled Plastic/Recycled Rubber loop", () => {
    // The exact case that surfaced this bug: at "fewestRawResources",
    // "Recycled Plastic" (Rubber + Fuel -> Plastic) and "Recycled Rubber"
    // (Plastic + Fuel -> Rubber) each look cheapest for their own part once
    // the other's weight is known — before the fix, this silently produced
    // 0-machine/0-demand nodes for everything downstream (Fuel, Heavy Oil
    // Residue, Crude Oil) instead of a real, connected plan.
    const plan = planFactory(gameData, [{ part: "Adaptive Control Unit", rate: of(60) }], {
      priority: "fewestRawResources",
    });

    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.some((n) => isZero(n.machineCount))).toBe(false);
    expect(plan.nodes.every((n) => !isZero(n.demand))).toBe(true);

    // The cycle is genuinely broken, not just coincidentally non-zero: at
    // most one of Plastic/Rubber can be using the mutually-referential
    // alternate — the other one must have fallen back.
    const plasticRecipe = plan.nodes.find((n) => n.part === "Plastic")?.recipe.name;
    const rubberRecipe = plan.nodes.find((n) => n.part === "Rubber")?.recipe.name;
    expect(plasticRecipe === "Recycled Plastic" && rubberRecipe === "Recycled Rubber").toBe(false);

    // Crude Oil (the true raw material at the bottom of this whole chain)
    // must show real, positive demand — this was the most visible symptom
    // of the bug (it showed 0/0 before the fix).
    const crudeOil = plan.nodes.find((n) => n.part === "Crude Oil");
    expect(crudeOil).toBeDefined();
    expect(isZero(crudeOil!.demand)).toBe(false);
  });
});

// Regression coverage for `PlanFactoryOptions.allowConverters: false`'s two
// exceptions (see that option's own doc comment): a part with NO
// non-Converter recipe at all must still resolve (necessity), and a
// Converter recipe that would otherwise win must still be allowed once the
// part's own Tier is at or above the Converter's (already-appropriate
// tier) — but NOT for an equally-cheap Converter recipe on a part whose
// Tier sits below it.
describe("planFactory allowConverters", () => {
  // Converter Tier 5-0. Two parts each have an inefficient standard recipe
  // (3 RawA per unit) and a cheaper Converter recipe (1.5 RawA per unit) —
  // one part sits AT the Converter's own Tier, the other well below it.
  // "ConverterOnly" has no standard recipe at all, at the LOW tier, to prove
  // necessity overrides even when the tier condition would otherwise fail.
  const converterFixture = loadGameData({
    Machines: [
      { Name: "Extractor", Tier: "0-0" },
      { Name: "Constructor", Tier: "0-0" },
      { Name: "Converter", Tier: "5-0" },
    ],
    MultiMachines: [],
    Parts: [
      { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
      { Name: "WidgetHighTier", Tier: "5-0", SinkPoints: 0 },
      { Name: "WidgetLowTier", Tier: "0-0", SinkPoints: 0 },
      { Name: "ConverterOnly", Tier: "0-0", SinkPoints: 0 },
    ],
    Recipes: [
      { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
      {
        Name: "WidgetHighTier Standard",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "RawA", Amount: "-6" },
          { Part: "WidgetHighTier", Amount: "2" },
        ],
      },
      {
        Name: "WidgetHighTier Converter",
        Machine: "Converter",
        BatchTime: "60",
        Tier: "5-0",
        Parts: [
          { Part: "RawA", Amount: "-3" },
          { Part: "WidgetHighTier", Amount: "2" },
        ],
      },
      {
        Name: "WidgetLowTier Standard",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "RawA", Amount: "-6" },
          { Part: "WidgetLowTier", Amount: "2" },
        ],
      },
      {
        Name: "WidgetLowTier Converter",
        Machine: "Converter",
        BatchTime: "60",
        Tier: "5-0",
        Parts: [
          { Part: "RawA", Amount: "-3" },
          { Part: "WidgetLowTier", Amount: "2" },
        ],
      },
      {
        Name: "ConverterOnly",
        Machine: "Converter",
        BatchTime: "60",
        Tier: "5-0",
        Parts: [
          { Part: "RawA", Amount: "-3" },
          { Part: "ConverterOnly", Amount: "2" },
        ],
      },
    ],
  });

  it("allows a Converter recipe once its part's own Tier is at or above the Converter's, when it would win anyway", () => {
    const plan = planFactory(converterFixture, [{ part: "WidgetHighTier", rate: of(2) }], {
      priority: "fewestRawResources",
      allowConverters: false,
    });
    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.find((n) => n.part === "WidgetHighTier")?.recipe.name).toBe("WidgetHighTier Converter");
  });

  it("keeps a Converter recipe excluded for a part below the Converter's Tier, even though it would otherwise win", () => {
    const plan = planFactory(converterFixture, [{ part: "WidgetLowTier", rate: of(2) }], {
      priority: "fewestRawResources",
      allowConverters: false,
    });
    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.find((n) => n.part === "WidgetLowTier")?.recipe.name).toBe("WidgetLowTier Standard");
  });

  it("allows a Converter recipe out of necessity even when the part's Tier is below the Converter's", () => {
    const plan = planFactory(converterFixture, [{ part: "ConverterOnly", rate: of(2) }], {
      priority: "fewestRawResources",
      allowConverters: false,
    });
    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.find((n) => n.part === "ConverterOnly")?.recipe.name).toBe("ConverterOnly");
  });

  it("real-data regression: Dark Matter Residue resolves via its own Converter recipe under balanced mode, matching PLAN.md's own tier-appropriateness call", () => {
    // Dark Matter Residue (Tier 9-2) has no OTHER dedicated producer — every
    // non-Converter "producer" is actually a Tier 9-2 end-game machine
    // recipe (e.g. AI Expansion Server) that makes it as a side product, not
    // a sane thing to build an entire factory branch around. With
    // Converters off, this used to force one of those absurd chains (or
    // leave inputs like "Excited Photonic Matter" — itself Converter-only —
    // unconnected); it should now just use the Converter directly.
    const plan = planFactory(gameData, [{ part: "Dark Matter Residue", rate: of(60) }], {
      priority: "balanced",
      allowConverters: false,
    });
    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.find((n) => n.part === "Dark Matter Residue")?.recipe.name).toBe("Dark Matter Residue");
    expect(plan.nodes.map((n) => n.part).sort()).toEqual(["Dark Matter Residue", "Reanimated SAM", "SAM"]);
  });

  it("real-data regression: a Converter-only part (Excited Photonic Matter) still resolves with Converters off", () => {
    const plan = planFactory(gameData, [{ part: "Excited Photonic Matter", rate: of(10) }], {
      priority: "balanced",
      allowConverters: false,
    });
    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.find((n) => n.part === "Excited Photonic Matter")?.recipe.name).toBe(
      "Excited Photonic Matter",
    );
  });

  it("real-data regression: a low-tier part (Iron Ore) is unaffected by Converters being off", () => {
    const plan = planFactory(gameData, [{ part: "Iron Ore", rate: of(60) }], {
      priority: "balanced",
      allowConverters: false,
    });
    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.find((n) => n.part === "Iron Ore")?.recipe.name).toBe("Iron Ore");
  });
});

describe("planFactory handleByproducts", () => {
  // MainOutput and SecondOutput each produce Byproduct as a side effect
  // alongside their own real output; "Byproduct to Converted" is a
  // single-input recipe that consumes Byproduct outright; "Byproduct
  // Direct" is a dedicated (non-byproduct) way to produce Byproduct, used
  // only by the "already independently produced" exclusion test below.
  const byproductFixture = loadGameData({
    Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
    MultiMachines: [],
    Parts: [
      { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
      { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
      { Name: "SecondOutput", Tier: "0-0", SinkPoints: 0 },
      { Name: "Byproduct", Tier: "0-0", SinkPoints: 0 },
      { Name: "Converted", Tier: "0-0", SinkPoints: 0 },
    ],
    Recipes: [
      { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
      {
        Name: "MainOutput",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "RawA", Amount: "-10" },
          { Part: "MainOutput", Amount: "5" },
          { Part: "Byproduct", Amount: "3" },
        ],
      },
      {
        Name: "SecondOutput",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "RawA", Amount: "-8" },
          { Part: "SecondOutput", Amount: "4" },
          { Part: "Byproduct", Amount: "2" },
        ],
      },
      {
        Name: "Byproduct Direct",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "RawA", Amount: "-5" },
          { Part: "Byproduct", Amount: "10" },
        ],
      },
      {
        Name: "Byproduct to Converted",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "Byproduct", Amount: "-3" },
          { Part: "Converted", Amount: "6" },
        ],
      },
    ],
  });

  it("does nothing when handleByproducts is left off", () => {
    const plan = planFactory(byproductFixture, [{ part: "MainOutput", rate: of(5) }]);
    expect(plan.byproductDisposals).toEqual([]);
  });

  it("finds a single-input conversion recipe and aggregates byproduct supply from multiple sources", () => {
    const plan = planFactory(
      byproductFixture,
      [
        { part: "MainOutput", rate: of(5) }, // exactly 1 machine -> 3/min Byproduct
        { part: "SecondOutput", rate: of(4) }, // exactly 1 machine -> 2/min Byproduct
      ],
      { handleByproducts: true },
    );

    expect(plan.byproductDisposals).toHaveLength(1);
    const disposal = plan.byproductDisposals[0]!;
    expect(disposal.part).toBe("Byproduct");
    expect(equals(disposal.totalRate, of(5))).toBe(true); // 3 + 2
    expect(disposal.sources.map((s) => s.fromPart).sort()).toEqual(["MainOutput", "SecondOutput"]);

    expect(disposal.conversion).toBeDefined();
    expect(disposal.conversion!.recipe.name).toBe("Byproduct to Converted");
    expect(equals(disposal.conversion!.machineCount, of(5, 3))).toBe(true); // 5/min demand / 3 per machine
    expect(disposal.conversion!.outputPart).toBe("Converted");
    expect(equals(disposal.conversion!.outputRate, of(10))).toBe(true); // 5/3 machines * 6/min per machine
  });

  it("sinks the byproduct raw when no conversion recipe survives disabledRecipes/allowConverters", () => {
    const plan = planFactory(byproductFixture, [{ part: "MainOutput", rate: of(5) }], {
      handleByproducts: true,
      disabledRecipes: new Set(["Byproduct to Converted"]),
    });

    expect(plan.byproductDisposals).toHaveLength(1);
    const disposal = plan.byproductDisposals[0]!;
    expect(disposal.part).toBe("Byproduct");
    expect(equals(disposal.totalRate, of(3))).toBe(true);
    expect(disposal.conversion).toBeUndefined();
  });

  it("still disposes a byproduct whose part is also independently produced by its own dedicated node", () => {
    const plan = planFactory(
      byproductFixture,
      [
        { part: "MainOutput", rate: of(5) },
        { part: "Byproduct", rate: of(10) }, // targeted directly too
      ],
      { handleByproducts: true },
    );

    // Sanity check on the tie-break this test relies on: Byproduct's own
    // dedicated node uses "Byproduct Direct", not the "MainOutput" recipe
    // that also happens to list it as a side output.
    expect(plan.nodes.find((n) => n.part === "Byproduct")?.recipe.name).toBe("Byproduct Direct");

    // The dedicated "Byproduct Direct" node is sized purely from the 10/min
    // direct-target demand — it never nets out MainOutput's extra 3/min
    // side output, so that 3/min is real surplus and must still be disposed
    // (see `FactoryPlan.byproductDisposals`'s own doc comment): sunk (via
    // its "Byproduct to Converted" conversion recipe) exactly like any other
    // byproduct with nowhere else to go, without changing the dedicated
    // node's own machine count.
    expect(plan.byproductDisposals).toHaveLength(1);
    const disposal = plan.byproductDisposals[0]!;
    expect(disposal.part).toBe("Byproduct");
    expect(equals(disposal.totalRate, of(3))).toBe(true);
    expect(disposal.sources.map((s) => s.fromPart)).toEqual(["MainOutput"]);
    expect(disposal.conversion).toBeDefined();
    expect(disposal.conversion!.recipe.name).toBe("Byproduct to Converted");
  });

  describe("raw-material reuse", () => {
    // RawA/RawB are both raw extraction (generation 0). MainOutput consumes
    // RawA directly. Recycler consumes RawB and produces RecyclerOutput
    // alongside a RawA byproduct — the same shape as the real
    // Aluminum-Scrap-producing-Water-while-Alumina-Solution-consumes-it
    // example this feature is modeled on.
    function reuseFixture(recyclerByproductAmount: string) {
      return loadGameData({
        Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
        MultiMachines: [],
        Parts: [
          { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
          { Name: "RawB", Tier: "0-0", SinkPoints: 0 },
          { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
          { Name: "RecyclerOutput", Tier: "0-0", SinkPoints: 0 },
        ],
        Recipes: [
          { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
          { Name: "RawB", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawB", Amount: "60" }] },
          {
            Name: "MainOutput",
            Machine: "Constructor",
            BatchTime: "60",
            Tier: "0-0",
            Parts: [
              { Part: "RawA", Amount: "-10" },
              { Part: "MainOutput", Amount: "5" },
            ],
          },
          {
            Name: "Recycler",
            Machine: "Constructor",
            BatchTime: "60",
            Tier: "0-0",
            Parts: [
              { Part: "RawB", Amount: "-8" },
              { Part: "RecyclerOutput", Amount: "4" },
              { Part: "RawA", Amount: recyclerByproductAmount },
            ],
          },
        ],
      });
    }

    it("shrinks the raw producer's machine count and wires the byproduct into its existing consumer when supply fits entirely within demand", () => {
      // MainOutput @ rate 5 -> 1 machine -> 10/min RawA demand. Recycler @
      // rate 4 -> 1 machine -> 6/min RawA byproduct (less than the 10/min
      // demand — the whole byproduct supply gets reused, nothing left over).
      const plan = planFactory(
        reuseFixture("6"),
        [
          { part: "MainOutput", rate: of(5) },
          { part: "RecyclerOutput", rate: of(4) },
        ],
        { handleByproducts: true },
      );

      const rawANode = plan.nodes.find((n) => n.part === "RawA")!;
      // Without reuse this would need 10/60 = 1/6 machines; with 6/min
      // reused, only the remaining 4/min needs raw extraction: 4/60 = 1/15.
      expect(equals(rawANode.machineCount, of(1, 15))).toBe(true);
      expect(equals(rawANode.demand, of(10))).toBe(true); // demand itself is unchanged — only how it's met changed

      const disposal = plan.byproductDisposals.find((d) => d.part === "RawA")!;
      expect(disposal).toBeDefined();
      expect(equals(disposal.totalRate, of(6))).toBe(true);
      expect(disposal.reuse).toBeDefined();
      expect(equals(disposal.reuse!.rate, of(6))).toBe(true);
      expect(disposal.reuse!.intoParts).toEqual(["MainOutput"]);
      expect(equals(disposal.disposalRate, of(0))).toBe(true);
      expect(disposal.conversion).toBeUndefined(); // nothing left to convert/sink
    });

    it("reuses only up to demand and still disposes of genuine leftover surplus", () => {
      // Recycler's own byproduct bumped to 15/min RawA — MORE than
      // MainOutput's 10/min demand, so only 10/min gets reused (fully
      // covering demand, dropping the raw extractor to zero) and the
      // remaining 5/min is real surplus that still needs disposing.
      const plan = planFactory(
        reuseFixture("15"),
        [
          { part: "MainOutput", rate: of(5) },
          { part: "RecyclerOutput", rate: of(4) },
        ],
        { handleByproducts: true },
      );

      const rawANode = plan.nodes.find((n) => n.part === "RawA")!;
      expect(isZero(rawANode.machineCount)).toBe(true); // fully covered by the byproduct alone

      const disposal = plan.byproductDisposals.find((d) => d.part === "RawA")!;
      expect(equals(disposal.totalRate, of(15))).toBe(true);
      expect(equals(disposal.reuse!.rate, of(10))).toBe(true); // capped at demand, not the full 15
      expect(equals(disposal.disposalRate, of(5))).toBe(true); // 15 - 10 left over
      expect(disposal.rawSinkAllowed).toBe(true); // RawA isn't a fluid — sinks raw
    });

    it("leaves a raw producer's machine count untouched when it has no in-graph consumer to route the byproduct into", () => {
      // RawA targeted directly (no in-graph consumer at all — MainOutput
      // isn't targeted this time) alongside Recycler: there's no `edges`
      // entry to wire the byproduct's replacement supply into, so reuse
      // should skip it entirely and fall back to plain disposal.
      const plan = planFactory(
        reuseFixture("6"),
        [
          { part: "RawA", rate: of(10) },
          { part: "RecyclerOutput", rate: of(4) },
        ],
        { handleByproducts: true },
      );

      const rawANode = plan.nodes.find((n) => n.part === "RawA")!;
      expect(equals(rawANode.machineCount, of(1, 6))).toBe(true); // full 10/min demand, un-reduced

      const disposal = plan.byproductDisposals.find((d) => d.part === "RawA")!;
      expect(disposal.reuse).toBeUndefined();
      expect(equals(disposal.disposalRate, of(6))).toBe(true);
    });
  });

  describe("fluid/gas packaging", () => {
    // FluidByproduct (Fluid: true) has NO single-input conversion recipe —
    // its only route to a sinkable form is "Packaging", a 2-input Packager
    // recipe that also needs "Carrier" (a stand-in for an empty
    // canister/fluid tank), which itself has its own tiny raw supply chain
    // (CarrierRaw -> Carrier).
    function packagingFixture() {
      return loadGameData({
        Machines: [
          { Name: "Extractor", Tier: "0-0" },
          { Name: "Constructor", Tier: "0-0" },
          { Name: "Packager", Tier: "0-0" },
        ],
        MultiMachines: [],
        Parts: [
          { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
          { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
          { Name: "FluidByproduct", Tier: "0-0", SinkPoints: 0, Fluid: true },
          { Name: "CarrierRaw", Tier: "0-0", SinkPoints: 0 },
          { Name: "Carrier", Tier: "0-0", SinkPoints: 0 },
          { Name: "PackagedFluid", Tier: "0-0", SinkPoints: 10 },
        ],
        Recipes: [
          { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
          {
            Name: "MainOutput",
            Machine: "Constructor",
            BatchTime: "60",
            Tier: "0-0",
            Parts: [
              { Part: "RawA", Amount: "-10" },
              { Part: "MainOutput", Amount: "5" },
              { Part: "FluidByproduct", Amount: "8" },
            ],
          },
          {
            Name: "CarrierRaw",
            Machine: "Extractor",
            BatchTime: "60",
            Tier: "0-0",
            Parts: [{ Part: "CarrierRaw", Amount: "60" }],
          },
          {
            Name: "Carrier",
            Machine: "Constructor",
            BatchTime: "60",
            Tier: "0-0",
            Parts: [
              { Part: "CarrierRaw", Amount: "-2" },
              { Part: "Carrier", Amount: "4" },
            ],
          },
          {
            Name: "Packaging",
            Machine: "Packager",
            BatchTime: "60",
            Tier: "0-0",
            Parts: [
              { Part: "FluidByproduct", Amount: "-2" },
              { Part: "Carrier", Amount: "-2" },
              { Part: "PackagedFluid", Amount: "2" },
            ],
          },
        ],
      });
    }

    it("builds a packaging conversion with its own recursive support chain for the second input", () => {
      const plan = planFactory(packagingFixture(), [{ part: "MainOutput", rate: of(5) }], { handleByproducts: true });

      const disposal = plan.byproductDisposals.find((d) => d.part === "FluidByproduct")!;
      expect(disposal).toBeDefined();
      expect(equals(disposal.disposalRate, of(8))).toBe(true); // no dedicated FluidByproduct producer to reuse into
      expect(disposal.rawSinkAllowed).toBe(false); // it's a fluid — raw sink is never valid

      expect(disposal.conversion).toBeDefined();
      expect(disposal.conversion!.recipe.name).toBe("Packaging");
      expect(equals(disposal.conversion!.machineCount, of(4))).toBe(true); // 8/min disposal / 2 per machine
      expect(disposal.conversion!.outputPart).toBe("PackagedFluid");
      expect(equals(disposal.conversion!.outputRate, of(8))).toBe(true);

      const support = disposal.conversion!.supportChain;
      expect(support).toBeDefined();
      expect(support!.part).toBe("Carrier");
      expect(equals(support!.rate, of(8))).toBe(true); // 4 conversion machines * 2 Carrier/machine

      const carrierNode = support!.nodes.find((n) => n.part === "Carrier")!;
      expect(carrierNode).toBeDefined();
      expect(equals(carrierNode.machineCount, of(2))).toBe(true); // 8/min needed / 4 per machine
      const carrierRawNode = support!.nodes.find((n) => n.part === "CarrierRaw")!;
      expect(carrierRawNode).toBeDefined();
      expect(equals(carrierRawNode.machineCount, of(1, 15))).toBe(true); // 4/min needed / 60 per machine
      expect(support!.edges).toContainEqual({ part: "CarrierRaw", fromPart: "CarrierRaw", toPart: "Carrier" });
    });

    it("leaves rawSinkAllowed false and conversion undefined when the carrier's own supply chain can't be resolved", () => {
      const plan = planFactory(packagingFixture(), [{ part: "MainOutput", rate: of(5) }], {
        handleByproducts: true,
        disabledRecipes: new Set(["Carrier"]), // the only route to the packaging recipe's second input
      });

      const disposal = plan.byproductDisposals.find((d) => d.part === "FluidByproduct")!;
      expect(disposal.conversion).toBeUndefined();
      expect(disposal.rawSinkAllowed).toBe(false);
      expect(equals(disposal.disposalRate, of(8))).toBe(true); // still reported — just nothing to wire it into
    });

    it("never picks a conversion whose own output is itself a fluid, even if the recipe would otherwise qualify", () => {
      const data = loadGameData({
        Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
        MultiMachines: [],
        Parts: [
          { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
          { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
          { Name: "FluidByproduct", Tier: "0-0", SinkPoints: 0, Fluid: true },
          { Name: "AnotherFluid", Tier: "0-0", SinkPoints: 0, Fluid: true },
        ],
        Recipes: [
          { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
          {
            Name: "MainOutput",
            Machine: "Constructor",
            BatchTime: "60",
            Tier: "0-0",
            Parts: [
              { Part: "RawA", Amount: "-10" },
              { Part: "MainOutput", Amount: "5" },
              { Part: "FluidByproduct", Amount: "8" },
            ],
          },
          {
            Name: "Fluid to Fluid",
            Machine: "Constructor",
            BatchTime: "60",
            Tier: "0-0",
            Parts: [
              { Part: "FluidByproduct", Amount: "-2" },
              { Part: "AnotherFluid", Amount: "2" },
            ],
          },
        ],
      });

      const plan = planFactory(data, [{ part: "MainOutput", rate: of(5) }], { handleByproducts: true });
      const disposal = plan.byproductDisposals.find((d) => d.part === "FluidByproduct")!;
      expect(disposal.conversion).toBeUndefined(); // "Fluid to Fluid" exists but its output doesn't solve anything
      expect(disposal.rawSinkAllowed).toBe(false);
    });
  });

  it("positions a disposal's conversion node and its own sink one level past its byproduct's source, never overlapping the main graph", () => {
    const plan = planFactory(byproductFixture, [{ part: "MainOutput", rate: of(5) }], { handleByproducts: true });
    const mainPositions = layoutFactoryPlan(plan, { basePosition: { x: 0, y: 0 } });
    const disposalLayout = layoutByproductDisposals(plan, { basePosition: { x: 0, y: 0 } });

    // MainOutput (the byproduct's only source) is also this plan's rightmost
    // main-graph node, so the general "one level past its own source" rule
    // and "past the whole main graph" happen to coincide here — the
    // multi-level fixture below is what actually distinguishes them.
    const maxMainX = Math.max(...[...mainPositions.values()].map((p) => p.x));
    const conversionPosition = disposalLayout.conversionPositions.get("Byproduct")!;
    expect(conversionPosition.x).toBeGreaterThan(maxMainX);
    expect(disposalLayout.sinkPositions.get("Byproduct")!.x).toBeGreaterThan(conversionPosition.x);
  });

  it("gives byproducts surfacing at different generations their own separate sinks, each next to its own source instead of bunched together", () => {
    // DeepOutput is TWO steps past RawA (RawA -> Mid -> DeepOutput) and
    // produces its own distinct byproduct, "Byproduct2" — a full generation
    // further right than MainOutput's own "Byproduct" (RawA -> MainOutput,
    // one step). Targeting both in the same plan exercises multiple
    // byproducts landing at different columns at once.
    const deepFixture = loadGameData({
      Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
      MultiMachines: [],
      Parts: [
        { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
        { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
        { Name: "Byproduct", Tier: "0-0", SinkPoints: 0 },
        { Name: "Mid", Tier: "0-0", SinkPoints: 0 },
        { Name: "DeepOutput", Tier: "0-0", SinkPoints: 0 },
        { Name: "Byproduct2", Tier: "0-0", SinkPoints: 0 },
      ],
      Recipes: [
        { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
        {
          Name: "MainOutput",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "RawA", Amount: "-10" },
            { Part: "MainOutput", Amount: "5" },
            { Part: "Byproduct", Amount: "3" },
          ],
        },
        {
          Name: "Mid",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "RawA", Amount: "-10" },
            { Part: "Mid", Amount: "5" },
          ],
        },
        {
          Name: "DeepOutput",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "Mid", Amount: "-5" },
            { Part: "DeepOutput", Amount: "4" },
            { Part: "Byproduct2", Amount: "2" },
          ],
        },
      ],
    });

    const plan = planFactory(
      deepFixture,
      [
        { part: "MainOutput", rate: of(5) },
        { part: "DeepOutput", rate: of(4) },
      ],
      { handleByproducts: true },
    );

    expect(plan.byproductDisposals.map((d) => d.part).sort()).toEqual(["Byproduct", "Byproduct2"]);
    expect(plan.nodes.find((n) => n.part === "MainOutput")!.generation).toBe(1);
    expect(plan.nodes.find((n) => n.part === "DeepOutput")!.generation).toBe(2);

    const disposalLayout = layoutByproductDisposals(plan, { basePosition: { x: 0, y: 0 } });
    const byproductSink = disposalLayout.sinkPositions.get("Byproduct")!;
    const byproduct2Sink = disposalLayout.sinkPositions.get("Byproduct2")!;

    // Two distinct sink nodes — not one shared node for the whole plan —
    // each sitting a level past its OWN byproduct's source generation.
    expect(byproductSink.x).not.toBe(byproduct2Sink.x);
    expect(byproduct2Sink.x).toBeGreaterThan(byproductSink.x);
  });
});

describe("planFactory handleByproducts: a recipe that lists the same part twice", () => {
  // Mirrors the real game-data shape that broke this (Encased Uranium Cell,
  // Distilled Silica, Instant Scrap all list one part name twice — once as
  // a consumed input, once as a partial-recycle byproduct output):
  // "SelfRef" consumes 8/min SharedPart AND produces 2/min SharedPart back
  // as a byproduct, in the SAME recipe. "SharedPart producer" is a
  // dedicated, non-raw (it needs RawA) way to make SharedPart — non-raw
  // specifically so `applyByproductReuse`'s reuse path is skipped and this
  // test exercises `planByproductDisposals` directly, same as the real
  // Sulfuric Acid/Encased Uranium Cell case.
  const selfRefFixture = loadGameData({
    Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
    MultiMachines: [],
    Parts: [
      { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
      { Name: "SharedPart", Tier: "0-0", SinkPoints: 0 },
      { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
      { Name: "Converted", Tier: "0-0", SinkPoints: 0 },
    ],
    Recipes: [
      { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
      {
        Name: "SharedPart producer",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "RawA", Amount: "-10" },
          { Part: "SharedPart", Amount: "5" },
        ],
      },
      {
        Name: "SelfRef",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "RawA", Amount: "-6" },
          { Part: "SharedPart", Amount: "-8" },
          { Part: "MainOutput", Amount: "5" },
          { Part: "SharedPart", Amount: "2" },
        ],
      },
      {
        Name: "SharedPart to Converted",
        Machine: "Constructor",
        BatchTime: "60",
        Tier: "0-0",
        Parts: [
          { Part: "SharedPart", Amount: "-3" },
          { Part: "Converted", Amount: "6" },
        ],
      },
    ],
  });

  it("correctly detects and disposes the byproduct entry's own (positive) rate, not the input entry's", () => {
    const plan = planFactory(selfRefFixture, [{ part: "MainOutput", rate: of(5) }], { handleByproducts: true });

    expect(plan.unresolvedParts).toEqual([]);
    expect(plan.nodes.find((n) => n.part === "MainOutput")?.recipe.name).toBe("SelfRef");
    expect(equals(machineCount(plan.nodes, "MainOutput")!, of(1))).toBe(true);

    // Before the fix: the byproduct entry's rate was silently computed as
    // the INPUT entry's (-8, by-name-ambiguous lookup), which
    // `planByproductDisposals` then drops as "not positive, nothing to
    // report" — so `byproductDisposals` would have had NO "SharedPart"
    // entry at all here, and the canvas would show it as an unhandled
    // byproduct despite `handleByproducts: true`.
    const disposal = plan.byproductDisposals.find((d) => d.part === "SharedPart");
    expect(disposal).toBeDefined();
    expect(equals(disposal!.totalRate, of(2))).toBe(true); // the +2 byproduct entry, not the -8 input entry
    expect(disposal!.disposalRate && equals(disposal!.disposalRate, of(2))).toBe(true);
    expect(disposal!.conversion).toBeDefined();
    expect(disposal!.conversion!.recipe.name).toBe("SharedPart to Converted");
  });
});

describe("layoutFactoryPlan", () => {
  it("places each generation in its own column and stacks a column's nodes without overlap", () => {
    const plan = planFactory(gameData, [{ part: "Rotor", rate: of(4) }]);
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

  it("with organize:true, reorders a column by its connections instead of alphabetically", () => {
    // Two raw materials (A, B) each feed exactly one distinct consumer (D
    // consumes only A, C consumes only B). Alphabetically, column 1 would
    // read [C, D] regardless of wiring — organize should instead notice D's
    // sole producer (A) sits ABOVE C's sole producer (B) in column 0, and
    // swap D above C so each consumer lines up near its own producer.
    const fixture = loadGameData({
      Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
      MultiMachines: [],
      Parts: [
        { Name: "A", Tier: "0-0", SinkPoints: 0 },
        { Name: "B", Tier: "0-0", SinkPoints: 0 },
        { Name: "C", Tier: "0-0", SinkPoints: 0 },
        { Name: "D", Tier: "0-0", SinkPoints: 0 },
      ],
      Recipes: [
        { Name: "A", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "A", Amount: "60" }] },
        { Name: "B", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "B", Amount: "60" }] },
        {
          Name: "D",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "A", Amount: "-60" },
            { Part: "D", Amount: "60" },
          ],
        },
        {
          Name: "C",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "B", Amount: "-60" },
            { Part: "C", Amount: "60" },
          ],
        },
      ],
    });
    const fixturePlan = planFactory(fixture, [
      { part: "C", rate: of(60) },
      { part: "D", rate: of(60) },
    ]);

    const alphabetical = layoutFactoryPlan(fixturePlan);
    expect(alphabetical.get("C")!.y).toBeLessThan(alphabetical.get("D")!.y);

    const organized = layoutFactoryPlan(fixturePlan, { organize: true });
    // Column 0 (A, B) has no producers of its own, so it's untouched, which
    // is what column 1's barycenter is computed against: A is above B.
    expect(organized.get("A")!.y).toBeLessThan(organized.get("B")!.y);
    // D (fed by A, the top of column 0) should now sit above C (fed by B).
    expect(organized.get("D")!.y).toBeLessThan(organized.get("C")!.y);
  });
});
