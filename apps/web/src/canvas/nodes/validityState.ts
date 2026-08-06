// Placeholder shape for Job 019's red/orange validity highlighting (PLAN.md
// §3: "red highlighting for invalid values and orange for non-matching").
// Nothing in this job (010) ever *constructs* one of these —
// `nodeRecordToFlowNode` (../useYjsSync.ts) always sets
// `CanvasNodeData.validityState` to `null`, and `RecipeNode.tsx` accepts but
// doesn't yet act on a non-null value. Job 019 is expected to compute one of
// these per node from solver output (red = invalid, orange = non-matching,
// per PLAN.md's own two-color scheme) and thread it through
// `CanvasNodeData.validityState` without needing to touch `RecipeNode.tsx`'s
// props/rendering contract at all — just fill in the (currently unused)
// styling this type's consumer would apply.
export type RecipeNodeValidity = "valid" | "invalid" | "mismatched";

export interface RecipeNodeValidityState {
  /** Overall highlight for the node card's border/background. */
  overall: RecipeNodeValidity;
  /** Optional per-field detail, for highlighting individual inputs rather than just the whole card. */
  fields?: Partial<Record<"limit" | "clock" | "shards", RecipeNodeValidity>>;
}
