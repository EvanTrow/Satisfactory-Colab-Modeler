// None mode: PLAN.md §2's table — "Nothing computed", instant. Deliberately
// does not even touch the snapshot's nodes/edges (no profile-building, no
// gamedata lookups) so it is trivially O(1) regardless of graph size.
import type { SolveResult } from "./result";

export function solveNone(): SolveResult {
  return {
    mode: "none",
    nodes: [],
    edges: [],
    summary: {
      perPart: {},
      powerMade: 0,
      powerUsed: 0,
      powerNet: 0,
      sinkPoints: "0",
    },
    valid: true,
    warnings: [],
  };
}
