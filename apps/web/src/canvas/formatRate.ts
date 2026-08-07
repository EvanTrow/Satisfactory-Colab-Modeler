// Shared by `nodes/RecipeNode.tsx` (per-part rate rows) and
// `edges/ConnectionEdge.tsx` (the wire label) — both display the same kind
// of value (a non-negative per-minute rate) against the same live
// `Settings.numberFormats` setting.
import { abs, formatRational, type Rational } from "@scm/rational";
import type { NumberFormats } from "@scm/ydoc";

export function formatRate(value: Rational, numberFormats: NumberFormats): string {
  return formatRational(abs(value), numberFormats);
}
