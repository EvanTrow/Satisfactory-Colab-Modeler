// Unit tests for the red-vs-orange mapping — see `computeValidity.ts`'s
// header comment for the precise rule being tested here. Deliberately
// constructs plain `NodeSolveResult`/`EdgeSolveResult` fixtures rather than
// running a real `@scm/solver` solve — this module's own contract is
// "given these solver shapes, produce this validity state," independent of
// how the solver actually produced them (that's `@scm/solver`'s own test
// suite's job).
import { describe, expect, it } from "vitest";
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import { computeNodeValidityState, type IncidentEdgeRef } from "./computeValidity";

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
  return {
    edgeId: "e1",
    part: "Iron Ore",
    rate: "0",
    valid: true,
    issues: [],
    ...overrides,
  };
}

describe("computeNodeValidityState", () => {
  it("returns null when there is no solver result for this node yet (None mode / pre-first-solve)", () => {
    expect(computeNodeValidityState(undefined, [], new Map())).toBeNull();
  });

  it("a perfectly valid, unconnected node highlights nothing", () => {
    const state = computeNodeValidityState(nodeResult(), [], new Map());
    expect(state).toEqual({ overall: "valid" });
  });

  it("an invalid limit (bad entered value) is RED and attributed to the limit field, not the whole card only", () => {
    const result = nodeResult({ valid: false, issues: ['invalid limit "not-a-number"'] });
    const state = computeNodeValidityState(result, [], new Map());
    expect(state?.overall).toBe("invalid");
    expect(state?.fields?.limit).toBe("invalid");
    expect(state?.fields?.shards).toBeUndefined();
  });

  it("a ppm limit with no anchorable part is RED on the limit field too", () => {
    const result = nodeResult({
      valid: false,
      issues: ['limitMode "ppm" but the recipe has no part to anchor it to'],
    });
    const state = computeNodeValidityState(result, [], new Map());
    expect(state?.overall).toBe("invalid");
    expect(state?.fields?.limit).toBe("invalid");
  });

  it("an out-of-range shard count is RED on the shards field", () => {
    const result = nodeResult({
      valid: false,
      issues: ["somersloopBoost: Manufacturer supports at most 4 production shard(s), got 5"],
    });
    const state = computeNodeValidityState(result, [], new Map());
    expect(state?.overall).toBe("invalid");
    expect(state?.fields?.shards).toBe("invalid");
    expect(state?.fields?.limit).toBeUndefined();
  });

  it("an unresolvable recipe/machine is RED on the card but no specific field (nothing to blame a field for)", () => {
    const result = nodeResult({ valid: false, issues: ['unknown recipe "Not A Real Recipe"'] });
    const state = computeNodeValidityState(result, [], new Map());
    expect(state?.overall).toBe("invalid");
    expect(state?.fields).toBeUndefined();
  });

  it("a rate-mismatch edge is ORANGE (mismatched), not red, on the affected port — the split-imbalance case", () => {
    const incident: IncidentEdgeRef[] = [{ edgeId: "e1", part: "Iron Ore" }];
    const edgeResultById = new Map([
      [
        "e1",
        edgeResult({
          valid: false,
          issues: ['rate mismatch on part "Iron Ore": source side 15/min, target side 30/min'],
        }),
      ],
    ]);
    const state = computeNodeValidityState(nodeResult(), incident, edgeResultById);
    expect(state?.overall).toBe("mismatched");
    expect(state?.ports?.["Iron Ore"]).toBe("mismatched");
    // Rate mismatch never touches limit/clock/shards — it's a port-level, not a field-level, condition.
    expect(state?.fields).toBeUndefined();
  });

  it("an edge whose endpoint couldn't be resolved is RED on the port (individually wrong), not orange", () => {
    const incident: IncidentEdgeRef[] = [{ edgeId: "e1", part: "Iron Ore" }];
    const edgeResultById = new Map([
      ["e1", edgeResult({ valid: false, issues: ['source node "n0" could not be resolved'] })],
    ]);
    const state = computeNodeValidityState(nodeResult(), incident, edgeResultById);
    expect(state?.overall).toBe("invalid");
    expect(state?.ports?.["Iron Ore"]).toBe("invalid");
  });

  it("a valid edge contributes nothing, even if listed as incident", () => {
    const incident: IncidentEdgeRef[] = [{ edgeId: "e1", part: "Iron Ore" }];
    const edgeResultById = new Map([["e1", edgeResult({ valid: true })]]);
    const state = computeNodeValidityState(nodeResult(), incident, edgeResultById);
    expect(state).toEqual({ overall: "valid" });
  });

  it("invalid (own node) always wins over mismatched (a sibling edge) on `overall`", () => {
    const bad = nodeResult({ valid: false, issues: ['invalid limit "x"'] });
    const incident: IncidentEdgeRef[] = [{ edgeId: "e1", part: "Iron Ore" }];
    const edgeResultById = new Map([
      [
        "e1",
        edgeResult({
          valid: false,
          issues: ['rate mismatch on part "Iron Ore": source side 1/min, target side 2/min'],
        }),
      ],
    ]);
    const state = computeNodeValidityState(bad, incident, edgeResultById);
    expect(state?.overall).toBe("invalid");
    expect(state?.fields?.limit).toBe("invalid");
    expect(state?.ports?.["Iron Ore"]).toBe("mismatched"); // the PORT itself is only mismatched — invalid escalation is `overall`-only when they come from different sources
  });

  it("two edges on the same part: invalid beats mismatched at the port level too", () => {
    const incidents: IncidentEdgeRef[] = [
      { edgeId: "e1", part: "Iron Ore" },
      { edgeId: "e2", part: "Iron Ore" },
    ];
    const edgeResultById = new Map([
      [
        "e1",
        edgeResult({
          edgeId: "e1",
          valid: false,
          issues: ['rate mismatch on part "Iron Ore": source side 1/min, target side 2/min'],
        }),
      ],
      [
        "e2",
        edgeResult({
          edgeId: "e2",
          valid: false,
          issues: ['target node "n2" could not be resolved'],
        }),
      ],
    ]);
    const state = computeNodeValidityState(nodeResult(), incidents, edgeResultById);
    expect(state?.ports?.["Iron Ore"]).toBe("invalid");
    expect(state?.overall).toBe("invalid");
  });

  it("Basic mode's 'no limit, no resolvable neighbor' fallback (valid:true, resolved:false) is highlighted as neither red nor orange", () => {
    const result = nodeResult({
      resolved: false,
      valid: true,
      issues: ["no limit and no resolvable neighbor — defaulted to 1 machine"],
    });
    const state = computeNodeValidityState(result, [], new Map());
    expect(state).toEqual({ overall: "valid" });
  });
});
