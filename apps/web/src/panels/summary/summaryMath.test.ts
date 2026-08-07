import { equals, of, parseRational } from "@scm/rational";
import { defaultGameData, type GameData } from "@scm/gamedata";
import { solve, type NodeSolveResult, type SolverSnapshot } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { nodeIdsForScope, summarizeScope } from "./summaryMath";

describe("nodeIdsForScope", () => {
  const allNodes = [
    { id: "a", containerId: "root" },
    { id: "b", containerId: "root" },
    { id: "c", containerId: "outpost-1" },
  ];

  it("everything: every node in the document, regardless of container", () => {
    const ids = nodeIdsForScope({
      scope: "everything",
      allNodes,
      currentContainerId: "root",
      selectedNodeIds: new Set(),
    });
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });

  it("outpost: only nodes whose containerId matches the currently-viewed container — direct children only", () => {
    const ids = nodeIdsForScope({
      scope: "outpost",
      allNodes,
      currentContainerId: "root",
      selectedNodeIds: new Set(),
    });
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("outpost: an empty result when viewing a container with no direct-child recipe nodes", () => {
    const ids = nodeIdsForScope({
      scope: "outpost",
      allNodes,
      currentContainerId: "outpost-2",
      selectedNodeIds: new Set(),
    });
    expect(ids.size).toBe(0);
  });

  it("selected: exactly the passed-in selection, independent of `allNodes`/`currentContainerId`", () => {
    const ids = nodeIdsForScope({
      scope: "selected",
      allNodes,
      currentContainerId: "root",
      selectedNodeIds: new Set(["b", "c"]),
    });
    expect([...ids].sort()).toEqual(["b", "c"]);
  });
});

describe("summarizeScope", () => {
  it("hand-computed balance/power/cost over a tiny fake GameData — the case a reviewer can check with a calculator", () => {
    const fakeGameData = {
      machinesByName: new Map([
        ["Fake Machine A", { cost: [{ part: "Steel Beam", amount: of(2) }] }],
        [
          "Fake Machine B",
          {
            cost: [
              { part: "Steel Beam", amount: of(1) },
              { part: "Cable", amount: of(3) },
            ],
          },
        ],
      ]),
    } as unknown as GameData;

    const nodeResults: NodeSolveResult[] = [
      {
        nodeId: "n1",
        machineCount: "2",
        clockPercent: "100",
        resolved: true,
        partRates: { "Iron Plate": "10" }, // made
        power: -5,
        valid: true,
        issues: [],
      },
      {
        nodeId: "n2",
        machineCount: "1/2",
        clockPercent: "100",
        resolved: true,
        partRates: { "Iron Plate": "-4", Screw: "20" }, // used 4, made 20
        power: -3,
        valid: true,
        issues: [],
      },
    ];

    const nodeRecordById = new Map([
      ["n1", { machine: "Fake Machine A" }],
      ["n2", { machine: "Fake Machine B" }],
    ]);

    const summary = summarizeScope(
      new Set(["n1", "n2"]),
      nodeResults,
      nodeRecordById,
      fakeGameData,
    );

    // Iron Plate: made 10, used 4 -> unmade 0, unused 6.
    expect(summary.perPart["Iron Plate"]).toEqual({
      made: "10",
      used: "4",
      unmade: "0",
      unused: "6",
    });
    // Screw: made 20, used 0 -> unused 20.
    expect(summary.perPart.Screw).toEqual({ made: "20", used: "0", unmade: "0", unused: "20" });

    expect(summary.powerMade).toBe(0);
    expect(summary.powerUsed).toBe(8); // 5 + 3
    expect(summary.powerNet).toBe(-8);
    expect(summary.sinkPoints).toBe("0");

    // Cost: Steel Beam = 2*2 (n1) + 1*(1/2) (n2) = 4 + 1/2 = 9/2. Cable = 3*(1/2) = 3/2.
    const cable = summary.cost.find((c) => c.part === "Cable");
    const steelBeam = summary.cost.find((c) => c.part === "Steel Beam");
    expect(equals(parseRational(cable!.amount), parseRational("3/2"))).toBe(true);
    expect(equals(parseRational(steelBeam!.amount), parseRational("9/2"))).toBe(true);

    expect(summary.nodeCount).toBe(2);
    expect(summary.solvedNodeCount).toBe(2);
  });

  it("a node id in scope with no matching NodeSolveResult is counted in nodeCount but not solvedNodeCount", () => {
    const summary = summarizeScope(new Set(["missing"]), [], new Map(), {
      machinesByName: new Map(),
    } as unknown as GameData);
    expect(summary.nodeCount).toBe(1);
    expect(summary.solvedNodeCount).toBe(0);
    expect(summary.perPart).toEqual({});
    expect(summary.cost).toEqual([]);
  });

  it("restricting to a subset excludes the other nodes' contribution entirely", () => {
    const nodeResults = [
      {
        nodeId: "n1",
        machineCount: "1",
        clockPercent: "100",
        resolved: true,
        partRates: { Water: "10" },
        power: 0,
        valid: true,
        issues: [],
      },
      {
        nodeId: "n2",
        machineCount: "1",
        clockPercent: "100",
        resolved: true,
        partRates: { Water: "-10" },
        power: 0,
        valid: true,
        issues: [],
      },
    ];
    const full = summarizeScope(new Set(["n1", "n2"]), nodeResults, new Map(), {
      machinesByName: new Map(),
    } as unknown as GameData);
    expect(full.perPart.Water).toEqual({ made: "10", used: "10", unmade: "0", unused: "0" });

    const n1Only = summarizeScope(new Set(["n1"]), nodeResults, new Map(), {
      machinesByName: new Map(),
    } as unknown as GameData);
    expect(n1Only.perPart.Water).toEqual({ made: "10", used: "0", unmade: "0", unused: "10" });
  });

  describe("integration against a real @scm/solver solve (PLAN.md §9's 30 Iron Ore -> 30 Iron Ingot case)", () => {
    const snapshot: SolverSnapshot = {
      nodes: [
        {
          id: "miner",
          recipe: "Iron Ore",
          machine: "Miner Mk.1",
          purity: "normal",
          limit: "30",
          limitMode: "ppm",
          clock: null,
          shards: 0,
        },
        {
          id: "smelter",
          recipe: "Iron Ingot",
          machine: "Smelter",
          purity: null,
          limit: null,
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
      ],
      edges: [
        {
          id: "edge-1",
          part: "Iron Ore",
          fromNode: "miner",
          fromPort: "out",
          toNode: "smelter",
          toPort: "in",
        },
      ],
    };
    const result = solve(snapshot, "basic", defaultGameData);
    const nodeRecordById = new Map([
      ["miner", { machine: "Miner Mk.1" }],
      ["smelter", { machine: "Smelter" }],
    ]);

    it("the 'Everything' scope reproduces @scm/solver's own whole-graph SolveSummary exactly", () => {
      const everything = summarizeScope(
        new Set(["miner", "smelter"]),
        result.nodes,
        nodeRecordById,
        defaultGameData,
      );
      expect(everything.perPart).toEqual(result.summary.perPart);
      expect(everything.powerMade).toBeCloseTo(result.summary.powerMade, 10);
      expect(everything.powerUsed).toBeCloseTo(result.summary.powerUsed, 10);
      expect(everything.powerNet).toBeCloseTo(result.summary.powerNet, 10);
    });

    it("Iron Ore is perfectly balanced (mined = smelted) and Iron Ingot is entirely unused (nothing downstream)", () => {
      const everything = summarizeScope(
        new Set(["miner", "smelter"]),
        result.nodes,
        nodeRecordById,
        defaultGameData,
      );
      expect(everything.perPart["Iron Ore"]).toEqual({
        made: "30",
        used: "30",
        unmade: "0",
        unused: "0",
      });
      expect(everything.perPart["Iron Ingot"]).toEqual({
        made: "30",
        used: "0",
        unmade: "0",
        unused: "30",
      });
    });

    it("restricting the scope to just the miner drops the smelter's consumption — Iron Ore reads as fully unused, not balanced", () => {
      const minerOnly = summarizeScope(
        new Set(["miner"]),
        result.nodes,
        nodeRecordById,
        defaultGameData,
      );
      expect(minerOnly.perPart["Iron Ore"]).toEqual({
        made: "30",
        used: "0",
        unmade: "0",
        unused: "30",
      });
      expect(minerOnly.perPart["Iron Ingot"]).toBeUndefined();
    });

    it("cost-to-build sums Machine.Cost x machineCount across both nodes (miner resolves to a fractional 1/2 machine)", () => {
      const minerNode = result.nodes.find((n) => n.nodeId === "miner")!;
      expect(equals(parseRational(minerNode.machineCount), parseRational("1/2"))).toBe(true);

      const everything = summarizeScope(
        new Set(["miner", "smelter"]),
        result.nodes,
        nodeRecordById,
        defaultGameData,
      );
      const byPart = new Map(everything.cost.map((c) => [c.part, c.amount] as const));
      // Miner Mk.1 Cost: Portable Miner x1, Iron Plate x10, Concrete x10, at machineCount 1/2.
      expect(equals(parseRational(byPart.get("Portable Miner")!), parseRational("1/2"))).toBe(true);
      expect(equals(parseRational(byPart.get("Concrete")!), of(5))).toBe(true);
      // Smelter Cost: Iron Rod x5, Wire x8, at machineCount 1 -> Iron Plate combines with the miner's own 10x(1/2)=5.
      expect(equals(parseRational(byPart.get("Iron Plate")!), of(5))).toBe(true);
      expect(equals(parseRational(byPart.get("Iron Rod")!), of(5))).toBe(true);
      expect(equals(parseRational(byPart.get("Wire")!), of(8))).toBe(true);
    });

    it("power: Miner Mk.1 draws 5MW/machine, Smelter 4MW/machine, both consuming (negative)", () => {
      const everything = summarizeScope(
        new Set(["miner", "smelter"]),
        result.nodes,
        nodeRecordById,
        defaultGameData,
      );
      // 5 * 1/2 + 4 * 1 = 2.5 + 4 = 6.5
      expect(everything.powerMade).toBeCloseTo(0, 10);
      expect(everything.powerUsed).toBeCloseTo(6.5, 10);
      expect(everything.powerNet).toBeCloseTo(-6.5, 10);
    });
  });
});
