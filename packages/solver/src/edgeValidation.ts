// Shared edge-consistency check, used identically by Manual mode (where
// every node's rate comes from its own entered values) and Basic mode
// (where it comes from a mix of pinned limits and graph-propagated
// inference) — see `manual.ts`/`basic.ts`. The check itself doesn't care
// which mode produced `counts`; it just asks "does the source's outgoing
// share for this part equal the target's incoming share," which is exactly
// PLAN.md §2's "same part, same rate in vs out at splits/merges" validation
// requirement.
import { equals, toFractionString, ZERO, type Rational } from "@scm/rational";
import { buildEdgeGroups, edgeShareFromSource, edgeShareFromTarget, type EdgeGroups } from "./edgeGroups";
import type { NodeProfile } from "./nodeProfile";
import type { SolverEdge } from "./snapshot";

export { buildEdgeGroups };
export type { EdgeGroups };

export interface EdgeValidationResult {
  /** The reported rate — the source side's even-split share. `ZERO` when either endpoint couldn't be resolved. */
  readonly rate: Rational;
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export function validateEdge(
  edge: SolverEdge,
  profiles: ReadonlyMap<string, NodeProfile>,
  counts: ReadonlyMap<string, Rational>,
  groups: EdgeGroups,
): EdgeValidationResult {
  const issues: string[] = [];
  const sourceProfile = profiles.get(edge.fromNode);
  const targetProfile = profiles.get(edge.toNode);
  const sourceCount = counts.get(edge.fromNode);
  const targetCount = counts.get(edge.toNode);

  if (!sourceProfile?.recipe || sourceCount === undefined) {
    issues.push(`source node "${edge.fromNode}" could not be resolved`);
  }
  if (!targetProfile?.recipe || targetCount === undefined) {
    issues.push(`target node "${edge.toNode}" could not be resolved`);
  }
  if (issues.length > 0) return { rate: ZERO, valid: false, issues };

  if (!sourceProfile!.refRatePerPart.has(edge.part)) {
    issues.push(`source node "${edge.fromNode}"'s recipe has no part "${edge.part}"`);
  }
  if (!targetProfile!.refRatePerPart.has(edge.part)) {
    issues.push(`target node "${edge.toNode}"'s recipe has no part "${edge.part}"`);
  }
  if (issues.length > 0) return { rate: ZERO, valid: false, issues };

  const sourceShare = edgeShareFromSource(edge, sourceProfile!, sourceCount!, groups);
  const targetShare = edgeShareFromTarget(edge, targetProfile!, targetCount!, groups);
  const valid = equals(sourceShare, targetShare);
  if (!valid) {
    issues.push(
      `rate mismatch on part "${edge.part}": source side ${toFractionString(sourceShare)}/min, target side ${toFractionString(targetShare)}/min`,
    );
  }
  return { rate: sourceShare, valid, issues };
}
