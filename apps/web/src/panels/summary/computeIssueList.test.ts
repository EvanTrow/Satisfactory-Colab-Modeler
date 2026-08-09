import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { computeIssueList, type EdgeResolution, type NodeResolution } from "./computeIssueList";

function nodeResult(overrides: Partial<NodeSolveResult> = {}): NodeSolveResult {
  return {
    nodeId: "n1",
    machineCount: "1",
    clockPercent: "100",
    resolved: true,
    partRates: {},
    power: 0,
    valid: true,
    issues: [],
    ...overrides,
  };
}

function edgeResult(overrides: Partial<EdgeSolveResult> = {}): EdgeSolveResult {
  return { edgeId: "e1", part: "Iron Ore", rate: "0", valid: true, issues: [], ...overrides };
}

const resolveNodeMap = new Map<string, NodeResolution>();
const resolveEdgeMap = new Map<string, EdgeResolution>();
function resolveNode(id: string): NodeResolution | undefined {
  return resolveNodeMap.get(id);
}
function resolveEdge(id: string): EdgeResolution | undefined {
  return resolveEdgeMap.get(id);
}

describe("computeIssueList", () => {
  it("returns [] when nothing is wrong", () => {
    resolveNodeMap.clear();
    resolveNodeMap.set("n1", { navigateNodeId: "n1", label: "Smelter" });
    expect(computeIssueList([nodeResult()], [], resolveNode, resolveEdge)).toEqual([]);
  });

  it("lists an invalid node with its own issue text", () => {
    resolveNodeMap.clear();
    resolveNodeMap.set("n1", { navigateNodeId: "n1", label: "Smelter" });
    const result = computeIssueList([nodeResult({ valid: false, issues: ['invalid limit "x"'] })], [], resolveNode, resolveEdge);
    expect(result).toEqual([
      {
        key: "node:n1",
        severity: "invalid",
        label: "Smelter",
        message: 'invalid limit "x"',
        navigateNodeIds: ["n1"],
      },
    ]);
  });

  it("lists an unresolved (defaulted) node distinctly from invalid", () => {
    resolveNodeMap.clear();
    resolveNodeMap.set("n1", { navigateNodeId: "n1", label: "Smelter" });
    const result = computeIssueList([nodeResult({ resolved: false, valid: true, issues: [] })], [], resolveNode, resolveEdge);
    expect(result).toHaveLength(1);
    expect(result[0]!.severity).toBe("unresolved");
  });

  it("lists a mismatched edge with the from/to labels and its issue text", () => {
    resolveEdgeMap.clear();
    resolveEdgeMap.set("e1", { fromNavigateNodeId: "a", toNavigateNodeId: "b", fromLabel: "Smelter", toLabel: "Constructor" });
    const result = computeIssueList(
      [],
      [edgeResult({ valid: false, issues: ['rate mismatch on part "Iron Ingot": source side 45/min, target side 60/min'] })],
      resolveNode,
      resolveEdge,
    );
    expect(result).toEqual([
      {
        key: "edge:e1",
        severity: "mismatched",
        label: "Smelter → Constructor",
        message: 'rate mismatch on part "Iron Ingot": source side 45/min, target side 60/min',
        navigateNodeIds: ["a", "b"],
      },
    ]);
  });

  it("drops an issue whose owning entity has no real on-canvas resolution", () => {
    resolveNodeMap.clear(); // n1 unresolved on purpose
    const result = computeIssueList([nodeResult({ valid: false, issues: ["boom"] })], [], resolveNode, resolveEdge);
    expect(result).toEqual([]);
  });

  it("ignores a valid edge and a fully-resolved valid node", () => {
    resolveNodeMap.clear();
    resolveNodeMap.set("n1", { navigateNodeId: "n1", label: "Smelter" });
    resolveEdgeMap.clear();
    resolveEdgeMap.set("e1", { fromNavigateNodeId: "a", toNavigateNodeId: "b", fromLabel: "A", toLabel: "B" });
    expect(computeIssueList([nodeResult()], [edgeResult()], resolveNode, resolveEdge)).toEqual([]);
  });

  it("sorts invalid before mismatched before unresolved, then alphabetically by label", () => {
    resolveNodeMap.clear();
    resolveNodeMap.set("unresolved-node", { navigateNodeId: "unresolved-node", label: "Zeta" });
    resolveNodeMap.set("invalid-node", { navigateNodeId: "invalid-node", label: "Alpha" });
    resolveEdgeMap.clear();
    resolveEdgeMap.set("e1", { fromNavigateNodeId: "a", toNavigateNodeId: "b", fromLabel: "Mid", toLabel: "Point" });

    const result = computeIssueList(
      [
        nodeResult({ nodeId: "unresolved-node", resolved: false, valid: true }),
        nodeResult({ nodeId: "invalid-node", valid: false, issues: ["broken"] }),
      ],
      [edgeResult({ valid: false, issues: ['rate mismatch on part "X": source side 1/min, target side 2/min'] })],
      resolveNode,
      resolveEdge,
    );
    expect(result.map((e) => e.severity)).toEqual(["invalid", "mismatched", "unresolved"]);
  });
});
