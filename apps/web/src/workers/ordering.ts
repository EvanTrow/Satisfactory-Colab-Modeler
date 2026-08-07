// The same determinism primitive `packages/solver/src/ordering.ts` uses
// (PLAN.md §5 point 4) — deliberately plain code-unit comparison, not
// `localeCompare` (locale collation can vary by platform/ICU version/
// runtime). Every module in this directory that needs a stable node/edge
// ordering (for cache-key signatures, merged result arrays, or component
// iteration order) goes through this one comparator, so results never
// depend on a snapshot's own array order. Duplicated here rather than
// imported from `@scm/solver` — that package's public API (`./index`)
// deliberately exposes only `solve()` plus the snapshot/result types (see
// `packages/solver/src/index.ts`), not its internal `ordering.ts`.
export function idCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Sorts a copy of `ids` via `idCompare` — never mutates its argument. */
export function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort(idCompare);
}
