// The determinism primitive every other module in this package builds on
// (PLAN.md §5, point 4: "we must pin a fixed variable ordering ... or
// collaborators will see different numbers for identical state"). Deliberately
// plain code-unit comparison, NOT `String.prototype.localeCompare` — locale
// collation can vary by platform/ICU version/runtime, which would silently
// reintroduce the exact nondeterminism this package exists to rule out.
// Every solve path sorts node/edge ids through this one comparator before
// doing anything order-sensitive.
export function idCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Sorts a copy of `ids` via `idCompare` — never mutates its argument. */
export function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort(idCompare);
}
