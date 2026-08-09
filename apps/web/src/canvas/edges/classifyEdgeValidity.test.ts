import type { EdgeSolveResult } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { classifyEdgeValidity } from "./classifyEdgeValidity";

function edgeResult(overrides: Partial<EdgeSolveResult> = {}): EdgeSolveResult {
  return { edgeId: "e1", part: "Iron Ore", rate: "0", valid: true, issues: [], ...overrides };
}

describe("classifyEdgeValidity", () => {
  it("is 'unknown' when there's no result for this edge at all", () => {
    expect(classifyEdgeValidity(undefined)).toBe("unknown");
  });

  it("is 'valid' when the edge resolved cleanly", () => {
    expect(classifyEdgeValidity(edgeResult())).toBe("valid");
  });

  it("is 'mismatched' for a rate-mismatch issue", () => {
    const result = edgeResult({
      valid: false,
      issues: ['rate mismatch on part "Iron Ore": source side 15/min, target side 30/min'],
    });
    expect(classifyEdgeValidity(result)).toBe("mismatched");
  });

  it("is 'invalid' for any other invalid reason", () => {
    const result = edgeResult({ valid: false, issues: [`source node "n0" could not be resolved`] });
    expect(classifyEdgeValidity(result)).toBe("invalid");
  });

  it("is 'invalid' (not 'mismatched') when invalid with zero issues (defensive)", () => {
    expect(classifyEdgeValidity(edgeResult({ valid: false, issues: [] }))).toBe("invalid");
  });
});
