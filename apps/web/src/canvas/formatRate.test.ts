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

  it("divides the producer's total evenly across several equally-dangling sibling wires, instead of duplicating the full rate onto each", () => {
    // Regression test for the live bug: a producer split across two
    // brand-new, empty outposts (nothing internal consuming yet, so neither
    // connection ever gets its own EdgeSolveResult) had BOTH wires
    // independently read the producer's FULL rate off `nodeResultById` —
    // 60/min shown twice from a single 60/min source.
    const e1 = edge({ id: "e1", fromNode: "producer", toNode: "outpost1-in", part: "Alclad Aluminum Sheet" });
    const e2 = edge({ id: "e2", fromNode: "producer", toNode: "outpost2-in", part: "Alclad Aluminum Sheet" });
    const nodeResultById = new Map([
      ["producer", nodeResult({ nodeId: "producer", partRates: { "Alclad Aluminum Sheet": "60" } })],
    ]);
    const allEdges = [e1, e2];
    expect(toFractionString(resolveEdgeRate(e1, new Map(), nodeResultById, allEdges)!)).toBe("30");
    expect(toFractionString(resolveEdgeRate(e2, new Map(), nodeResultById, allEdges)!)).toBe("30");
  });

  it("gives a resolved sibling's own known share no weight in the remaining split — only the OTHER still-dangling wires divide what's left", () => {
    const e1 = edge({ id: "e1", fromNode: "producer", toNode: "resolvedConsumer", part: "Iron Ore" });
    const e2 = edge({ id: "e2", fromNode: "producer", toNode: "outpost1-in", part: "Iron Ore" });
    const e3 = edge({ id: "e3", fromNode: "producer", toNode: "outpost2-in", part: "Iron Ore" });
    const edgeResultById = new Map([["e1", edgeResult({ edgeId: "e1", rate: "20" })]]);
    const nodeResultById = new Map([
      ["producer", nodeResult({ nodeId: "producer", partRates: { "Iron Ore": "60" } })],
    ]);
    const allEdges = [e1, e2, e3];
    // e1 already resolved to 20 directly — never touches the fallback path.
    expect(toFractionString(resolveEdgeRate(e1, edgeResultById, nodeResultById, allEdges)!)).toBe("20");
    // The remaining 40 (60 - 20) splits evenly across e2 and e3.
    expect(toFractionString(resolveEdgeRate(e2, edgeResultById, nodeResultById, allEdges)!)).toBe("20");
    expect(toFractionString(resolveEdgeRate(e3, edgeResultById, nodeResultById, allEdges)!)).toBe("20");
  });

  it("still returns the whole rate unchanged for the ordinary single-dangling-edge case (no sibling at all)", () => {
    const record = edge({ id: "e1", fromNode: "producer", toNode: "io-out:c1", part: "Heat Sink" });
    const nodeResultById = new Map([["producer", nodeResult({ nodeId: "producer", partRates: { "Heat Sink": "12" } })]]);
    expect(toFractionString(resolveEdgeRate(record, new Map(), nodeResultById, [record])!)).toBe("12");
  });

  it("divides a merge's consumed total evenly across dangling producer-side siblings on the toNode fallback path too", () => {
    const e1 = edge({ id: "e1", fromNode: "producerA", toNode: "consumer", part: "Iron Ore" });
    const e2 = edge({ id: "e2", fromNode: "producerB", toNode: "consumer", part: "Iron Ore" });
    const nodeResultById = new Map([
      ["consumer", nodeResult({ nodeId: "consumer", partRates: { "Iron Ore": "-30" } })],
    ]);
    const allEdges = [e1, e2];
    expect(toFractionString(resolveEdgeRate(e1, new Map(), nodeResultById, allEdges)!)).toBe("-15");
    expect(toFractionString(resolveEdgeRate(e2, new Map(), nodeResultById, allEdges)!)).toBe("-15");
  });
});
