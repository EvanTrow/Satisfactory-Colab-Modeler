import type { EdgeSolveResult } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { computeMismatchDetails, type MismatchEdgeRef } from "./computeMismatchDetails";

function edgeResult(overrides: Partial<EdgeSolveResult> = {}): EdgeSolveResult {
  return { edgeId: "e1", part: "Cable", rate: "0", valid: true, issues: [], ...overrides };
}

describe("computeMismatchDetails", () => {
  it("returns {} when nothing is incident", () => {
    expect(computeMismatchDetails([], new Map())).toEqual({});
  });

  it("returns {} when every incident edge is valid", () => {
    const incident: MismatchEdgeRef[] = [{ edgeId: "e1", part: "Cable" }];
    const edgeResultById = new Map([["e1", edgeResult()]]);
    expect(computeMismatchDetails(incident, edgeResultById)).toEqual({});
  });

  it("ignores an invalid edge whose issue isn't a rate mismatch", () => {
    const incident: MismatchEdgeRef[] = [{ edgeId: "e1", part: "Cable" }];
    const edgeResultById = new Map([
      ["e1", edgeResult({ valid: false, issues: [`source node "a" could not be resolved`] })],
    ]);
    expect(computeMismatchDetails(incident, edgeResultById)).toEqual({});
  });

  it("strips the redundant prefix and surfaces the solver's own explanation", () => {
    const incident: MismatchEdgeRef[] = [{ edgeId: "e1", part: "Cable" }];
    const edgeResultById = new Map([
      [
        "e1",
        edgeResult({
          valid: false,
          issues: [`rate mismatch on part "Cable": source side 15/min, target side 30/min`],
        }),
      ],
    ]);
    expect(computeMismatchDetails(incident, edgeResultById)).toEqual({
      Cable: "source side 15/min, target side 30/min",
    });
  });

  it("surfaces the joint-solver's aggregate shortfall wording verbatim (minus the prefix)", () => {
    const incident: MismatchEdgeRef[] = [{ edgeId: "e1", part: "Iron Ingot" }];
    const edgeResultById = new Map([
      [
        "e1",
        edgeResult({
          part: "Iron Ingot",
          valid: false,
          issues: [
            `rate mismatch on part "Iron Ingot": 1 connected producer(s) fall 15/min short of 2 connected consumer(s)' combined demand`,
          ],
        }),
      ],
    ]);
    expect(computeMismatchDetails(incident, edgeResultById)).toEqual({
      "Iron Ingot": "1 connected producer(s) fall 15/min short of 2 connected consumer(s)' combined demand",
    });
  });

  it("deduplicates identical explanations across sibling edges for the same part", () => {
    const incident: MismatchEdgeRef[] = [
      { edgeId: "e1", part: "Cable" },
      { edgeId: "e2", part: "Cable" },
    ];
    const issue = `rate mismatch on part "Cable": source side 15/min, target side 30/min`;
    const edgeResultById = new Map([
      ["e1", edgeResult({ valid: false, issues: [issue] })],
      ["e2", edgeResult({ edgeId: "e2", valid: false, issues: [issue] })],
    ]);
    expect(computeMismatchDetails(incident, edgeResultById)).toEqual({
      Cable: "source side 15/min, target side 30/min",
    });
  });

  it("joins distinct explanations for two different edges disagreeing on the same part", () => {
    const incident: MismatchEdgeRef[] = [
      { edgeId: "e1", part: "Cable" },
      { edgeId: "e2", part: "Cable" },
    ];
    const edgeResultById = new Map([
      [
        "e1",
        edgeResult({ valid: false, issues: [`rate mismatch on part "Cable": source side 15/min, target side 30/min`] }),
      ],
      [
        "e2",
        edgeResult({
          edgeId: "e2",
          valid: false,
          issues: [`rate mismatch on part "Cable": source side 10/min, target side 5/min`],
        }),
      ],
    ]);
    expect(computeMismatchDetails(incident, edgeResultById)).toEqual({
      Cable: "source side 15/min, target side 30/min; source side 10/min, target side 5/min",
    });
  });

  it("reports multiple mismatched parts on the same node independently", () => {
    const incident: MismatchEdgeRef[] = [
      { edgeId: "e1", part: "Cable" },
      { edgeId: "e2", part: "Wire" },
    ];
    const edgeResultById = new Map([
      [
        "e1",
        edgeResult({ valid: false, issues: [`rate mismatch on part "Cable": source side 15/min, target side 30/min`] }),
      ],
      [
        "e2",
        edgeResult({
          edgeId: "e2",
          part: "Wire",
          valid: false,
          issues: [`rate mismatch on part "Wire": source side 60/min, target side 45/min`],
        }),
      ],
    ]);
    expect(computeMismatchDetails(incident, edgeResultById)).toEqual({
      Cable: "source side 15/min, target side 30/min",
      Wire: "source side 60/min, target side 45/min",
    });
  });

  it("treats an edge missing from edgeResultById as not contributing", () => {
    const incident: MismatchEdgeRef[] = [{ edgeId: "e1", part: "Cable" }];
    expect(computeMismatchDetails(incident, new Map())).toEqual({});
  });
});
