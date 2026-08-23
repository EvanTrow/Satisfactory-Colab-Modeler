// Shared by `nodes/RecipeNode.tsx` (per-part rate rows) and
// `edges/ConnectionEdge.tsx` (the wire label, including a boundary-crossing
// one) — both display the same kind of value (a non-negative per-minute rate)
// against the same live `Settings.numberFormats` setting.
import { abs, formatRational, parseRational, type Rational } from "@scm/rational";
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import type { EdgeRecord, NumberFormats } from "@scm/ydoc";

export function formatRate(value: Rational, numberFormats: NumberFormats): string {
  return formatRational(abs(value), numberFormats);
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
 * part name. Safe to apply unconditionally (not just for outpost/Splurger
 * edges): an ordinary two-recipe edge only ever has NO `EdgeSolveResult` at
 * all before the first solve completes, at which point `nodeResultById` is
 * equally empty and this still correctly returns `null`.
 */
export function resolveEdgeRate(
  record: EdgeRecord,
  edgeResultById: ReadonlyMap<string, EdgeSolveResult>,
  nodeResultById: ReadonlyMap<string, NodeSolveResult>,
): Rational | null {
  const direct = edgeResultById.get(record.id)?.rate;
  if (direct !== undefined) return parseRational(direct);
  const fromRate = nodeResultById.get(record.fromNode)?.partRates[record.part];
  if (fromRate !== undefined) return parseRational(fromRate);
  const toRate = nodeResultById.get(record.toNode)?.partRates[record.part];
  if (toRate !== undefined) return parseRational(toRate);
  return null;
}
