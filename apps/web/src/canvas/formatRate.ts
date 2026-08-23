// Shared by `nodes/RecipeNode.tsx` (per-part rate rows) and
// `edges/ConnectionEdge.tsx` (the wire label, including a boundary-crossing
// one) — both display the same kind of value (a non-negative per-minute rate)
// against the same live `Settings.numberFormats` setting.
import { abs, add, divide, isNegative, negate, of, parseRational, subtract, ZERO, formatRational, type Rational } from "@scm/rational";
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import type { EdgeRecord, NumberFormats } from "@scm/ydoc";

export function formatRate(value: Rational, numberFormats: NumberFormats): string {
  return formatRational(abs(value), numberFormats);
}

/**
 * Splits `total` (a shared node's own signed produced/consumed rate for one
 * part — the same fallback figure `resolveEdgeRate` reads off `nodeResultById`
 * below) across every OTHER edge sharing that same `(ownerNode, part)` on
 * `side` that is ALSO still dangling (no direct `EdgeSolveResult` of its
 * own) — so a producer fanning out to several destinations with nothing yet
 * resolving any of the individual wires (e.g. two brand-new, empty outposts)
 * shows each wire its own even share of the total instead of the WHOLE
 * total duplicated onto every single one of them. A sibling that DID resolve
 * already claims a real, known slice of `total`, so its magnitude is
 * subtracted first — the remainder is what's actually left to divide among
 * the genuinely-still-unknown ones. Reduces to returning `total` unchanged
 * for the ordinary single-dangling-edge case (`danglingCount === 1`,
 * nothing resolved) `resolveEdgeRate`'s existing tests already cover.
 */
function shareAmongDanglingSiblings(
  total: Rational,
  ownerNode: string,
  side: "fromNode" | "toNode",
  part: string,
  edgeResultById: ReadonlyMap<string, EdgeSolveResult>,
  allEdges: readonly EdgeRecord[],
): Rational {
  let resolvedMagnitude = ZERO;
  let danglingCount = 0;
  for (const sibling of allEdges) {
    if (sibling[side] !== ownerNode || sibling.part !== part) continue;
    const result = edgeResultById.get(sibling.id);
    if (result) resolvedMagnitude = add(resolvedMagnitude, parseRational(result.rate));
    else danglingCount += 1;
  }
  if (danglingCount <= 1) return total;
  const remaining = subtract(abs(total), resolvedMagnitude);
  const share = divide(isNegative(remaining) ? ZERO : remaining, of(danglingCount));
  return isNegative(total) ? negate(share) : share;
}

/**
 * The rate to show on a WIRE's own label — preferring the edge's own solved
 * result (already resolved to a real `EdgeSolveResult` even for a Splurger/
 * outpost-input/outpost-output pass-through connection whose synthetic
 * result got aliased back onto it, see `useSolver.ts`'s `indexEdges`), and
 * falling back to whichever REAL endpoint's own produced/consumed rate for
 * this part when nothing resolved at all — the same "no complete circuit
 * yet, but the amount is still knowable from one side" fallback
 * `outposts/io.ts`'s `computeIoPartRate` already applies to a card's own
 * port rows, now applied to the wire itself so a dangling pass-through
 * connection's waypoint isn't the only place left showing just the bare
 * part name. `allEdges` lets that fallback divide fairly
 * (`shareAmongDanglingSiblings`) when MORE THAN ONE sibling edge shares the
 * same owning node + part and is equally dangling — e.g. a producer split
 * across two still-empty outposts, which used to each independently show
 * the producer's FULL rate (confirmed live: both wires read the source's
 * whole output rather than an even share). Safe to apply unconditionally
 * (not just for outpost/Splurger edges): an ordinary two-recipe edge only
 * ever has NO `EdgeSolveResult` at all before the first solve completes, at
 * which point `nodeResultById` is equally empty and this still correctly
 * returns `null`.
 */
export function resolveEdgeRate(
  record: EdgeRecord,
  edgeResultById: ReadonlyMap<string, EdgeSolveResult>,
  nodeResultById: ReadonlyMap<string, NodeSolveResult>,
  allEdges: readonly EdgeRecord[] = [record],
): Rational | null {
  const direct = edgeResultById.get(record.id)?.rate;
  if (direct !== undefined) return parseRational(direct);
  const fromRate = nodeResultById.get(record.fromNode)?.partRates[record.part];
  if (fromRate !== undefined) {
    return shareAmongDanglingSiblings(parseRational(fromRate), record.fromNode, "fromNode", record.part, edgeResultById, allEdges);
  }
  const toRate = nodeResultById.get(record.toNode)?.partRates[record.part];
  if (toRate !== undefined) {
    return shareAmongDanglingSiblings(parseRational(toRate), record.toNode, "toNode", record.part, edgeResultById, allEdges);
  }
  return null;
}
