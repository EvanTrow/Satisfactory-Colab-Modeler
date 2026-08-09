// Job 010 built this shape as a placeholder for Job 019's red/orange
// validity highlighting (PLAN.md §3: "red highlighting for invalid values
// and orange for non-matching"); Job 019 (`canvas/nodes/computeValidity.ts`)
// is the first thing to actually construct a non-null value here. See that
// module's header comment for the precise red ("invalid") vs orange
// ("mismatched") mapping this job chose — in short: "invalid" is a value
// that's individually wrong on its own terms (an unparseable/unsatisfiable
// limit, an unresolvable recipe/machine/shard count), "mismatched" is a
// value that's individually fine but doesn't reconcile with what a
// connected neighbor is sending/expecting (a Basic-mode split/merge rate
// disagreement). Invalid always wins over mismatched when a node/port has
// both.
//
// A later pass (the calculation-validation visuals review) added a fourth,
// lower-severity tier: `"unresolved"` — Basic/Full mode's "no limit and no
// resolvable neighbor, defaulted to 1 machine" case (`NodeSolveResult.resolved
// === false` with `.valid === true`). This was a documented gap since Job
// 019 itself (this file's own original comment: "PLAN.md's two-color scheme
// has no color for" it) — the node isn't wrong, and there's no neighbor
// value to disagree with, but the count shown is genuinely undetermined
// rather than authoritative. Severity order is now
// `invalid > mismatched > unresolved > valid` — see `computeValidity.ts`'s
// `escalate`.
export type RecipeNodeValidity = "valid" | "invalid" | "mismatched" | "unresolved";

export interface RecipeNodeValidityState {
  /** Overall highlight for the node card's border/background — the worst (most severe) state among the node's own fields and every port below. */
  overall: RecipeNodeValidity;
  /** Optional per-field detail, for highlighting individual inputs rather than just the whole card. Only ever populated from the node's OWN issues (never from an edge/port issue) — see `computeValidity.ts`. */
  fields?: Partial<Record<"limit" | "clock" | "shards", RecipeNodeValidity>>;
  /**
   * Job 019 addition: per-part port highlighting, keyed by `RecipePart.part`
   * (the same key `PartRow`'s handle id is built from, minus the
   * `"in:"`/`"out:"` direction prefix — a part name is unique per side of a
   * single recipe, so this doesn't need the prefix to disambiguate).
   * Populated from edge-level (`EdgeSolveResult`) issues touching this node,
   * never from the node's own issues. Not part of Job 010's original
   * contract (only `fields`/`overall` existed then) — added here because
   * "the affected node fields/ports" (this job's own scope wording) has no
   * other natural home for per-part detail; `RecipeNode.tsx`'s prop shape
   * (`data.validityState`) itself is unchanged, exactly as Job 010's
   * handoff notes predicted.
   */
  ports?: Readonly<Record<string, RecipeNodeValidity>>;
}
