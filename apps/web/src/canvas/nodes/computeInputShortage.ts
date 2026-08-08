// A machine whose input ports aren't receiving as much of a part as its
// current machine count/clock actually demands can't run at the rate its
// card displays — the game would just starve it. `computeValidity.ts`'s
// existing "mismatched" (orange) state already catches this incidentally
// (an edge's source/target shares disagreeing), but only for a part that
// already HAS a connected edge, and it doesn't distinguish "short" from
// "oversupplied" or say by how much. This module answers the narrower,
// more actionable question directly: for each input part, is what's
// actually arriving (summed across every incoming edge, `"0"` for a part
// with no incoming edge at all) less than what this node's own solved rate
// says it needs — and if so, by how much.
//
// Deliberately pure and React/Yjs-free, same discipline as
// `recipeNodeMath.ts`/`computeValidity.ts` — unit-testable with plain
// fixture objects, no `SfmDocument`, no `@scm/gamedata` lookups beyond the
// `RecipePart[]` the caller already has in hand.
import type { RecipePart } from "@scm/gamedata";
import { ZERO, abs, add, compare, isNegative, isZero, parseRational, subtract, type Rational } from "@scm/rational";
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";

export interface PartShortage {
  /** This node's own solved demand for the part (always positive — the sign of `RecipePart.amount` is already accounted for). */
  readonly required: Rational;
  /** Sum of every incoming edge's own computed rate for the part. */
  readonly supplied: Rational;
  /** `required - supplied`, always positive (that's what makes it a shortage). */
  readonly deficit: Rational;
}

/** An edge landing on THIS node (`edge.toNode === id`) — just enough to sum by part. */
export interface IncomingEdgeRef {
  readonly edgeId: string;
  readonly part: string;
}

/**
 * One node's per-part input shortages, keyed by `RecipePart.part`. `{}` when
 * `nodeResult` is `undefined` (no solve has run for this node yet — same
 * "nothing to report" convention as `computeNodeValidityState`) or every
 * input part is fully supplied. Output parts never appear here — "not
 * enough items per minute" is an input-side concept only.
 */
export function computeInputShortages(
  nodeResult: NodeSolveResult | undefined,
  recipeParts: readonly RecipePart[],
  incomingEdges: readonly IncomingEdgeRef[],
  edgeResultById: ReadonlyMap<string, EdgeSolveResult>,
): Readonly<Record<string, PartShortage>> {
  if (!nodeResult) return {};

  const shortages: Record<string, PartShortage> = {};
  for (const part of recipeParts) {
    if (!isNegative(part.amount)) continue;
    const rateStr = nodeResult.partRates[part.part];
    if (rateStr === undefined) continue;
    const required = abs(parseRational(rateStr));
    if (isZero(required)) continue;

    const supplied = incomingEdges
      .filter((edge) => edge.part === part.part)
      .reduce((sum, edge) => {
        const result = edgeResultById.get(edge.edgeId);
        return result ? add(sum, parseRational(result.rate)) : sum;
      }, ZERO);

    if (compare(supplied, required) < 0) {
      shortages[part.part] = { required, supplied, deficit: subtract(required, supplied) };
    }
  }
  return shortages;
}
