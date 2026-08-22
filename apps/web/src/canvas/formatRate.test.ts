import { toFractionString } from "@scm/rational";
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import type { EdgeRecord } from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { resolveEdgeRate } from "./formatRate";

function edge(overrides: Partial<EdgeRecord> & { id: string }): EdgeRecord {
  return {
    containerId: "c_x",
    part: "Iron Ore",
    fromNode: "a",
    fromPort: "out",
    toNode: "b",
    toPort: "in",
    waypoints: [],
    style: null,
    labelPos: null,
    ...overrides,
  };
}

function edgeResult(overrides: Partial<EdgeSolveResult> & { edgeId: string; rate: string }): EdgeSolveResult {
  return { part: "Iron Ore", valid: true, issues: [], ...overrides };
}

function nodeResult(overrides: Partial<NodeSolveResult> & { nodeId: string; partRates: Record<string, string> }): NodeSolveResult {
  return { machineCount: "1", clockPercent: "100", resolved: true, power: 0, valid: true, issues: [], ...overrides };
}

describe("resolveEdgeRate", () => {
  it("prefers the edge's own resolved result when one exists", () => {
    const record = edge({ id: "e1", fromNode: "a", toNode: "b", part: "Iron Ore" });
    const edgeResultById = new Map([["e1", edgeResult({ edgeId: "e1", rate: "30" })]]);
    const nodeResultById = new Map([["a", nodeResult({ nodeId: "a", partRates: { "Iron Ore": "999" } })]]);
    const rate = resolveEdgeRate(record, edgeResultById, nodeResultById);
    expect(rate).not.toBeNull();
    // 30 (the edge's own result) — never 999 (the fallback), which must not be consulted when a direct result exists.
    expect(toFractionString(rate!)).toBe("30");
  });

  it("falls back to the fromNode's own party rate when nothing resolved directly", () => {
    const record = edge({ id: "e1", fromNode: "producer", toNode: "io-out:c1", part: "Heat Sink" });
    const nodeResultById = new Map([["producer", nodeResult({ nodeId: "producer", partRates: { "Heat Sink": "12" } })]]);
    const rate = resolveEdgeRate(record, new Map(), nodeResultById);
    expect(rate).not.toBeNull();
    expect(toFractionString(rate!)).toBe("12");
  });

  it("falls back to the toNode's own party rate when the fromNode has none", () => {
    const record = edge({ id: "e1", fromNode: "io-in:c1", toNode: "consumer", part: "Iron Ore" });
    const nodeResultById = new Map([["consumer", nodeResult({ nodeId: "consumer", partRates: { "Iron Ore": "-30" } })]]);
    const rate = resolveEdgeRate(record, new Map(), nodeResultById);
    expect(rate).not.toBeNull();
    expect(toFractionString(rate!)).toBe("-30");
  });

  it("returns null when neither the edge nor either endpoint has a rate for this part", () => {
    const record = edge({ id: "e1", fromNode: "a", toNode: "b", part: "Iron Ore" });
    expect(resolveEdgeRate(record, new Map(), new Map())).toBeNull();
  });

  it("returns null before any solve has run (both maps empty) rather than fabricating a rate", () => {
    const record = edge({ id: "e1" });
    expect(resolveEdgeRate(record, new Map(), new Map())).toBeNull();
  });
});
