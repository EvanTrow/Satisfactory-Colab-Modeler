import type { RecipePart } from "@scm/gamedata";
import { of } from "@scm/rational";
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { computeInputShortages, type IncomingEdgeRef } from "./computeInputShortage";

function part(name: string, amount: number): RecipePart {
  return { part: name, amount: of(amount) };
}

function nodeResult(partRates: Record<string, string>): NodeSolveResult {
  return {
    nodeId: "n1",
    machineCount: "1",
    clockPercent: "100",
    resolved: true,
    partRates,
    power: 0,
    valid: true,
    issues: [],
  };
}

function edgeResult(rate: string, overrides: Partial<EdgeSolveResult> = {}): EdgeSolveResult {
  return { edgeId: "e1", part: "Iron Ore", rate, valid: true, issues: [], ...overrides };
}

describe("computeInputShortages", () => {
  it("returns {} when there's no solver result yet", () => {
    expect(computeInputShortages(undefined, [part("Iron Ore", -30)], [], new Map())).toEqual({});
  });

  it("returns {} for a fully-unconnected node with no demand", () => {
    const result = nodeResult({});
    expect(computeInputShortages(result, [part("Iron Ore", -30)], [], new Map())).toEqual({});
  });

  it("flags an input part with no incoming edge at all as fully short", () => {
    const result = nodeResult({ "Iron Ore": "-30" });
    const shortages = computeInputShortages(result, [part("Iron Ore", -30)], [], new Map());
    expect(shortages["Iron Ore"]).toEqual({ required: of(30), supplied: of(0), deficit: of(30) });
  });

  it("flags a connected-but-undersupplied part with the exact deficit", () => {
    const result = nodeResult({ "Iron Ore": "-30" });
    const incoming: IncomingEdgeRef[] = [{ edgeId: "e1", part: "Iron Ore" }];
    const edgeResultById = new Map([["e1", edgeResult("20")]]);
    const shortages = computeInputShortages(result, [part("Iron Ore", -30)], incoming, edgeResultById);
    expect(shortages["Iron Ore"]).toEqual({ required: of(30), supplied: of(20), deficit: of(10) });
  });

  it("sums multiple incoming edges for the same part before comparing", () => {
    const result = nodeResult({ "Iron Ore": "-30" });
    const incoming: IncomingEdgeRef[] = [
      { edgeId: "e1", part: "Iron Ore" },
      { edgeId: "e2", part: "Iron Ore" },
    ];
    const edgeResultById = new Map([
      ["e1", edgeResult("12")],
      ["e2", edgeResult("18", { edgeId: "e2" })],
    ]);
    expect(computeInputShortages(result, [part("Iron Ore", -30)], incoming, edgeResultById)).toEqual({});
  });

  it("does not flag a fully or over-supplied part", () => {
    const result = nodeResult({ "Iron Ore": "-30" });
    const incoming: IncomingEdgeRef[] = [{ edgeId: "e1", part: "Iron Ore" }];
    const edgeResultById = new Map([["e1", edgeResult("45")]]);
    expect(computeInputShortages(result, [part("Iron Ore", -30)], incoming, edgeResultById)).toEqual({});
  });

  it("never flags an output part", () => {
    const result = nodeResult({ "Iron Plate": "30" });
    expect(computeInputShortages(result, [part("Iron Plate", 30)], [], new Map())).toEqual({});
  });

  it("treats an incoming edge with no solve result yet as contributing zero", () => {
    const result = nodeResult({ "Iron Ore": "-30" });
    const incoming: IncomingEdgeRef[] = [{ edgeId: "e1", part: "Iron Ore" }];
    const shortages = computeInputShortages(result, [part("Iron Ore", -30)], incoming, new Map());
    expect(shortages["Iron Ore"]).toEqual({ required: of(30), supplied: of(0), deficit: of(30) });
  });

  it("reports multiple short parts on the same node independently", () => {
    const result = nodeResult({ "Iron Ore": "-30", "Copper Ore": "-20" });
    const incoming: IncomingEdgeRef[] = [{ edgeId: "e1", part: "Copper Ore" }];
    const edgeResultById = new Map([["e1", edgeResult("5", { part: "Copper Ore" })]]);
    const shortages = computeInputShortages(
      result,
      [part("Iron Ore", -30), part("Copper Ore", -20)],
      incoming,
      edgeResultById,
    );
    expect(Object.keys(shortages).sort()).toEqual(["Copper Ore", "Iron Ore"]);
    expect(shortages["Iron Ore"]!.deficit).toEqual(of(30));
    expect(shortages["Copper Ore"]!.deficit).toEqual(of(15));
  });
});
