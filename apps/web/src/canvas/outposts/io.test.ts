import { toFractionString } from "@scm/rational";
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { computeIoDanglingParts, computeIoNodePorts, computeIoPartRate } from "./io";

function edgeResult(overrides: Partial<EdgeSolveResult> & { edgeId: string; rate: string }): EdgeSolveResult {
  return { part: "Iron Ore", valid: true, issues: [], ...overrides };
}

function nodeResult(overrides: Partial<NodeSolveResult> & { nodeId: string; partRates: Record<string, string> }): NodeSolveResult {
  return { machineCount: "1", clockPercent: "100", resolved: true, power: 0, valid: true, issues: [], ...overrides };
}

function edge(overrides: Partial<{ id: string; part: string; fromNode: string; toNode: string }> & { id: string }) {
  return {
    id: overrides.id,
    containerId: "c_x",
    part: overrides.part ?? "Iron Ore",
    fromNode: overrides.fromNode ?? "a",
    fromPort: "out",
    toNode: overrides.toNode ?? "b",
    toPort: "in",
    waypoints: [],
    style: null,
    labelPos: null,
  };
}

describe("computeIoDanglingParts", () => {
  it("flags a part wired only on the external side (internal producer/consumer never connected)", () => {
    // Outputs-node shape: internalDirection "in" (fed by an internal producer).
    const edges = [edge({ id: "e1", part: "Rubber", fromNode: "io-out:c1", toNode: "external-consumer" })];
    expect([...computeIoDanglingParts(edges, "io-out:c1", "in")]).toEqual(["Rubber"]);
  });

  it("flags a part wired only on the internal side (never connected out to anything external)", () => {
    const edges = [edge({ id: "e1", part: "Rubber", fromNode: "internal-producer", toNode: "io-out:c1" })];
    expect([...computeIoDanglingParts(edges, "io-out:c1", "in")]).toEqual(["Rubber"]);
  });

  it("does not flag a part wired on both sides", () => {
    const edges = [
      edge({ id: "e1", part: "Rubber", fromNode: "internal-producer", toNode: "io-out:c1" }),
      edge({ id: "e2", part: "Rubber", fromNode: "io-out:c1", toNode: "external-consumer" }),
    ];
    expect(computeIoDanglingParts(edges, "io-out:c1", "in").size).toBe(0);
  });

  it("is empty for a node with no incident edges at all", () => {
    expect(computeIoDanglingParts([], "io-out:c1", "in").size).toBe(0);
  });

  it("works the same way for an Inputs node (internalDirection 'out')", () => {
    // Only the external producer side is wired — nothing internal draws from it yet.
    const edges = [edge({ id: "e1", part: "Iron Ore", fromNode: "external-producer", toNode: "io-in:c1" })];
    expect([...computeIoDanglingParts(edges, "io-in:c1", "out")]).toEqual(["Iron Ore"]);
  });
});

describe("computeIoNodePorts", () => {
  it("lists a distinct row per part touching the node, from either side", () => {
    const edges = [
      edge({ id: "e1", part: "Rubber", fromNode: "internal-producer", toNode: "io-out:c1" }),
      edge({ id: "e2", part: "Rubber", fromNode: "io-out:c1", toNode: "external-consumer" }),
      edge({ id: "e3", part: "Plastic", fromNode: "io-out:c1", toNode: "other-consumer" }),
      edge({ id: "e4", part: "Iron Ore", fromNode: "unrelated-a", toNode: "unrelated-b" }),
    ];
    const ports = computeIoNodePorts(edges, "io-out:c1");
    expect(ports).toEqual([
      { part: "Plastic", edgeIds: ["e3"] },
      { part: "Rubber", edgeIds: ["e1", "e2"] },
    ]);
  });

  it("shows a part wired on only ONE side (internal-only, no external connection yet)", () => {
    const edges = [edge({ id: "e1", part: "Heat Sink", fromNode: "internal-producer", toNode: "io-out:c1" })];
    expect(computeIoNodePorts(edges, "io-out:c1")).toEqual([{ part: "Heat Sink", edgeIds: ["e1"] }]);
  });

  it("is empty for a node with no incident edges", () => {
    expect(computeIoNodePorts([], "io-out:c1")).toEqual([]);
  });
});

describe("computeIoPartRate", () => {
  it("does NOT double-count a complete 1-to-1 circuit (internal and external edges alias to the SAME EdgeSolveResult object)", () => {
    // Both edges alias to the same object — exactly what `useSolver.ts`'s
    // `indexEdges` produces for an unambiguous 1-to-1 pass-through.
    const shared = edgeResult({ edgeId: "sp:in>out", rate: "30", part: "Rubber" });
    const edgeResultById = new Map<string, EdgeSolveResult>([
      ["internal-edge", shared],
      ["external-edge", shared],
    ]);
    const edges = [
      edge({ id: "internal-edge", part: "Rubber", fromNode: "producer", toNode: "io-out:c1" }),
      edge({ id: "external-edge", part: "Rubber", fromNode: "io-out:c1", toNode: "consumer" }),
    ];
    const rate = computeIoPartRate(edges, "io-out:c1", "Rubber", edgeResultById, new Map());
    expect(rate).not.toBeNull();
    // 30, never 60 — summing both edges naively would double it.
    expect(toFractionString(rate!)).toBe("30");
  });

  it("sums DISTINCT resolved results for a real splitter shape (two separate synthetic edges)", () => {
    const toA = edgeResult({ edgeId: "sp:in>outA", rate: "20", part: "Rubber" });
    const toB = edgeResult({ edgeId: "sp:in>outB", rate: "10", part: "Rubber" });
    const edgeResultById = new Map<string, EdgeSolveResult>([
      ["edge-to-a", toA],
      ["edge-to-b", toB],
    ]);
    const edges = [
      edge({ id: "edge-to-a", part: "Rubber", fromNode: "io-out:c1", toNode: "consumerA" }),
      edge({ id: "edge-to-b", part: "Rubber", fromNode: "io-out:c1", toNode: "consumerB" }),
    ];
    const rate = computeIoPartRate(edges, "io-out:c1", "Rubber", edgeResultById, new Map());
    expect(rate).not.toBeNull();
    expect(toFractionString(rate!)).toBe("30");
  });

  it("falls back to the other endpoint's own party rate when nothing resolved (half-wired, no external consumer yet)", () => {
    const edges = [edge({ id: "e1", part: "Heat Sink", fromNode: "producer", toNode: "io-out:c1" })];
    const nodeResultById = new Map<string, NodeSolveResult>([
      ["producer", nodeResult({ nodeId: "producer", partRates: { "Heat Sink": "12" } })],
    ]);
    const rate = computeIoPartRate(edges, "io-out:c1", "Heat Sink", new Map(), nodeResultById);
    expect(rate).not.toBeNull();
    expect(toFractionString(rate!)).toBe("12");
  });

  it("sums the fallback rate across multiple one-sided edges (two internal producers, no external consumer yet)", () => {
    const edges = [
      edge({ id: "e1", part: "Heat Sink", fromNode: "producerA", toNode: "io-out:c1" }),
      edge({ id: "e2", part: "Heat Sink", fromNode: "producerB", toNode: "io-out:c1" }),
    ];
    const nodeResultById = new Map<string, NodeSolveResult>([
      ["producerA", nodeResult({ nodeId: "producerA", partRates: { "Heat Sink": "12" } })],
      ["producerB", nodeResult({ nodeId: "producerB", partRates: { "Heat Sink": "8" } })],
    ]);
    const rate = computeIoPartRate(edges, "io-out:c1", "Heat Sink", new Map(), nodeResultById);
    expect(rate).not.toBeNull();
    expect(toFractionString(rate!)).toBe("20");
  });

  it("returns null when there's nothing resolved and no fallback rate available either", () => {
    const edges = [edge({ id: "e1", part: "Heat Sink", fromNode: "producer", toNode: "io-out:c1" })];
    expect(computeIoPartRate(edges, "io-out:c1", "Heat Sink", new Map(), new Map())).toBeNull();
  });

  it("returns null for a part with no incident edges at all", () => {
    expect(computeIoPartRate([], "io-out:c1", "Heat Sink", new Map(), new Map())).toBeNull();
  });
});
