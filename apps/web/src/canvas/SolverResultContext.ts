// Job 019: exposes Job 018's live solver output (`useSolver(sfmDoc)`, from
// `../workers`) to every descendant of `<CanvasView>` that needs it —
// `RecipeNode.tsx` (real per-part rates + validity highlighting) and
// `panels/SummaryPanel.tsx` (aggregate figures) both read this instead of
// each calling `useSolver` themselves.
//
// This matters for more than tidiness: `useSolver.ts`'s own header comment
// says it "creates (once per `sfmDoc` identity) a `SolveScheduler` + its own
// Zustand store" — i.e. every call site gets its OWN scheduler and its OWN
// Web Worker pair. `RecipeNode` is mounted once per node on the canvas
// (potentially dozens), so calling `useSolver` directly inside it would spin
// up dozens of redundant debounce/cache/worker stacks all solving the exact
// same document independently — wasteful at best, and a correctness risk at
// worst (dozens of workers racing to update dozens of independent staleness
// flags that are all supposed to describe the same document). `CanvasView.tsx`
// (`CanvasViewReady`) is the single call site; everything else reads this
// context, mirroring `CanvasDocContext.ts`'s own "hand out the live value,
// not a copy" pattern.
import { createContext, useContext } from "react";

import type { UseSolverResult } from "../workers";

export const SolverResultContext = createContext<UseSolverResult | null>(null);

/**
 * Reads the live solver result. Throws if called outside a `<CanvasView>`
 * subtree — same fail-fast pattern `useCanvasDoc()` already uses, since
 * there's no sensible default solver output to fall back to.
 */
export function useSolverResult(): UseSolverResult {
  const value = useContext(SolverResultContext);
  if (!value) {
    throw new Error("useSolverResult() must be called underneath <CanvasView>");
  }
  return value;
}
