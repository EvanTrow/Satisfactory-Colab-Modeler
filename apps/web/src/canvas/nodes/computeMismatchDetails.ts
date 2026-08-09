// The solver already computes and explains WHY two sides of a "rate
// mismatch" disagree — `edgeValidation.ts`/`full.ts`'s tiered path reports
// the exact two numbers ("source side 15/min, target side 30/min");
// `edgeResolution.ts`'s joint path reports the aggregate producer/consumer
// shortfall. But `computeValidity.ts` only tracks WHICH part is mismatched
// (for the red/orange ring), not why, so `RecipeNode.tsx` historically threw
// that detail away and showed users a bare, unhelpful "Cable doesn't
// reconcile with a connected neighbor." This module recovers the solver's
// own explanation instead of re-deriving the numbers itself (which would
// risk drifting from the solver's actual math across its two different
// resolution paths), keyed by part so both the card-level banner and each
// row's own tooltip can show it.
//
// Deliberately pure and React/Yjs-free, same discipline as
// `computeInputShortage.ts`/`computeValidity.ts` — unit-testable with plain
// fixture objects.
import type { EdgeSolveResult } from "@scm/solver";

export interface MismatchEdgeRef {
  readonly edgeId: string;
  readonly part: string;
}

/**
 * Strips the redundant `rate mismatch on part "X": ` prefix every
 * solver-generated mismatch issue starts with (see `edgeValidation.ts`'s and
 * `edgeResolution.ts`'s `describeShortfall` — both share this exact prefix)
 * — callers already know/display the part name themselves.
 */
const RATE_MISMATCH_PREFIX = /^rate mismatch on part "[^"]*":\s*/i;

/**
 * One node's per-part rate-mismatch explanation, keyed by `RecipePart.part`
 * — the solver's own issue text for that part's incident edges (deduplicated;
 * a part fed by several distinctly-disagreeing edges gets each explanation,
 * joined). `{}` when nothing incident to this node is mismatched.
 */
export function computeMismatchDetails(
  incidentEdges: readonly MismatchEdgeRef[],
  edgeResultById: ReadonlyMap<string, EdgeSolveResult>,
): Readonly<Record<string, string>> {
  const detailsByPart = new Map<string, Set<string>>();
  for (const edge of incidentEdges) {
    const result = edgeResultById.get(edge.edgeId);
    if (!result || result.valid) continue;
    for (const issue of result.issues) {
      if (!RATE_MISMATCH_PREFIX.test(issue)) continue;
      const detail = issue.replace(RATE_MISMATCH_PREFIX, "");
      const set = detailsByPart.get(edge.part) ?? new Set<string>();
      set.add(detail);
      detailsByPart.set(edge.part, set);
    }
  }

  const details: Record<string, string> = {};
  for (const [part, set] of detailsByPart) {
    details[part] = [...set].join("; ");
  }
  return details;
}
