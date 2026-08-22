// The ONE place a single `EdgeSolveResult` gets turned into a validity tier
// — extracted out of `../nodes/computeValidity.ts`'s per-edge loop so every
// OTHER consumer that wants to color/ring something by a specific edge's
// own validity (the edge's own path in `ConnectionEdge.tsx`/`BoundaryEdge.tsx`,
// an Outpost boundary port keyed by `DerivedOutpostPort.edgeId`, a
// Sink/Storage per-part row) shares the exact same rule instead of
// re-implementing the "is this a rate mismatch or something worse" check.
// `computeValidity.ts` itself now calls this too — no behavior change there,
// see `computeValidity.test.ts`.
import type { EdgeSolveResult } from "@scm/solver";

export type EdgeValidity = "invalid" | "mismatched" | "valid" | "unknown";

/** Same pattern `computeValidity.ts` already used to distinguish "rate mismatch" (orange) from every other invalid-edge reason (red) — see that module's header for the full red-vs-orange rule. */
const RATE_MISMATCH_PATTERN = /rate mismatch/i;

/**
 * `"unknown"` when there's no result for this edge yet — e.g. no solve has
 * run, or (Splurger's rewrite in particular) the edge's incident node
 * doesn't survive into the solver snapshot under its original id at all.
 * Callers should treat `"unknown"` as "nothing to say," not as an error.
 */
export function classifyEdgeValidity(edgeResult: EdgeSolveResult | undefined): EdgeValidity {
  if (!edgeResult) return "unknown";
  if (edgeResult.valid) return "valid";
  return edgeResult.issues.some((issue) => RATE_MISMATCH_PATTERN.test(issue)) ? "mismatched" : "invalid";
}
