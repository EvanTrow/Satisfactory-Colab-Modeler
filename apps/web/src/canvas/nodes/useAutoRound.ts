// Job 027: wires `autoRound.ts`'s pure decision math to the live document
// and Job 018's live solver output. Mounted exactly ONCE — `CanvasView.tsx`'s
// `CanvasViewReady`, right alongside its single `useSolver(sfmDoc)` call —
// never once per `RecipeNode`, for the identical reason `SolverResultContext`'s
// own header comment gives for `useSolver` itself: a per-node call site would
// duplicate work and, worse here, could race independent writes to
// `NodeRecord.clock` against each other for no reason.
//
// ---------------------------------------------------------------------------
// How "manually touching clock or limit switches auto-round off" actually
// works — read this before assuming it needs a transaction-origin check
// ---------------------------------------------------------------------------
// This hook's own write (see below) is the ONLY place in the app that
// writes a new `clock` value WITHOUT also clearing `NodeRecord.autoRound`.
// Every real user-edit path that touches `clock`/`limit`
// (`RecipeNode.tsx`'s `commitLimit`, `commitClock`, and `handleClockStep` —
// the ± buttons) explicitly sets `autoRound: false` in the SAME `updateNode`
// call as the value change. That call-site separation, not a Yjs
// transaction-origin inspection, is the actual mechanism that distinguishes
// "the user touched this field" from "auto-round's own correction": there
// is structurally no way for this hook's write to be mistaken for a manual
// edit, because this hook never touches `autoRound` at all, and no manual
// edit path ever reaches this file. `AUTO_ROUND_ORIGIN` (below) is still
// attached to this hook's own transactions, but it's a deliberate
// belt-and-suspenders addition (see its own doc comment) — the origin tag
// is not what correctness rests on.
//
// ---------------------------------------------------------------------------
// Why gating on `staleness === "fresh"` is both necessary and sufficient
// ---------------------------------------------------------------------------
// `nodeResultById` can (briefly) describe a solve that's already superseded
// by a newer, still-in-flight edit — that's exactly what `staleness ===
// "stale-recomputing"` signals (Job 018). Acting on a stale result here
// would mean computing a clock correction against numbers that are about to
// change anyway, for no benefit and a real risk of writing a value the very
// next tick immediately overwrites again. Waiting for `"fresh"` means this
// only ever acts on a genuinely settled result — and because a settled
// result's write is a proven fixed point (see `autoRound.ts`'s header for
// the full argument), "wait for fresh, then apply once" is enough: there is
// no scenario where a fresh-but-still-wrong result needs a second immediate
// follow-up correction beyond the one self-terminating echo round-trip that
// same header describes.
//
// ---------------------------------------------------------------------------
// ★ A real, pre-existing gap this job's convergence analysis surfaced: a
// pinned "machines"-mode limit makes clock genuinely INERT — skip those
// nodes entirely (read this before removing `PINNED_MACHINES_MODE` below)
// ---------------------------------------------------------------------------
// `autoRound.ts`'s whole "clock never changes rates, only machine count"
// argument silently assumes the solved machine count IS a function of
// clock. That's true for a `"ppm"`-mode limit and for any unpinned node
// (both go through `machineCountForTargetRate`, which divides by
// `clockFraction`) — but it's FALSE for a pinned `"machines"`-mode limit:
// `packages/solver/src/nodeProfile.ts`'s `pinnedMachineCount` returns
// `{ count: limitValue }` **literally, with no clock term at all** for that
// case (verified by reading the function directly, and confirmed live: a
// node with `limitMode: "machines"`, `limit: "5/2"` held `machineCount:
// "5/2"` in a real solve no matter what clock it was given). This is the
// REAL, correct, tested semantic (`manual.ts`/`basic.ts`/`full.ts` all call
// the same `pinnedMachineCount` identically) — "Limit (machines)" means
// "this many machines, full stop"; clock only scales each machine's own
// throughput. It just means the manual ± buttons AND this feature share one
// real blind spot: `recipeNodeMath.ts`'s own `computeMachineCount` (which
// the ± buttons' `handleClockStep` still uses) disagrees with this and
// treats "machines" mode as clock-dependent too — a Job 010-era assumption
// that predates the real solver and was never revisited once Job 017-019
// landed. That mismatch is `RecipeNode.tsx`'s ± buttons' problem to fix, not
// this hook's (flagged in jobs/027's Handoff notes for a later job) — but
// THIS hook, reacting to the REAL `nodeResultById`, has to actively guard
// against it: without the check below, a pinned machines-mode node with a
// non-integer `limit` (e.g. a user literally typing "2.5" machines) would
// see `computeAutoRoundClock` compute a "correction" every settled solve,
// write it, and the NEXT solve would report the exact same non-integer
// count regardless (since clock never entered the calculation) — not an
// infinite loop (the geometric clock-shrink this produces empirically hits
// `MIN_CLOCK_PERCENT` and the `equals()` guard below does stop further
// writes once clamped), but a real, observed, useless drift of the clock
// all the way down to the 1% floor for zero benefit, confirmed live in this
// job's own manual browser verification before this guard was added.
import { useEffect } from "react";

import type { NodeSolveResult } from "@scm/solver";
import { equals, parseRational, toFractionString } from "@scm/rational";
import { listNodes, updateNode, type SfmDocument } from "@scm/ydoc";

import type { SolveStaleness } from "../../workers";
import { computeAutoRoundClock } from "./autoRound";
import { effectiveClockPercent } from "./recipeNodeMath";

/**
 * Reserved transaction origin for auto-round's own automatic clock writes.
 * Two things fall out of this for free, neither requiring any change to
 * `packages/ydoc`:
 *   1. `createUndoManager` (`packages/ydoc/src/undo.ts`) defaults
 *      `trackedOrigins` to `new Set([null])` — any non-null origin is
 *      already excluded from the undo stack with zero configuration change
 *      needed here, the same way `INTEGRITY_ORIGIN` is excluded (Job 022).
 *      This is deliberate: an automatic background correction shouldn't
 *      clutter a user's undo history the way `runAsIntegrity`'s repairs
 *      don't either — pressing Undo after auto-round silently nudges a
 *      clock should undo the user's OWN last real edit, not fight the
 *      correction that's about to reapply itself anyway.
 *   2. It makes this write source unambiguous in a Yjs update-event log for
 *      debugging. Nothing in this app currently branches on it for
 *      correctness — see the header comment above for why call-site
 *      separation, not this tag, is the load-bearing mechanism.
 */
export const AUTO_ROUND_ORIGIN = "auto-round" as const;

export function useAutoRound(
  sfmDoc: SfmDocument,
  nodeResultById: ReadonlyMap<string, NodeSolveResult>,
  staleness: SolveStaleness,
): void {
  useEffect(() => {
    if (staleness !== "fresh") return;

    for (const node of listNodes(sfmDoc)) {
      if (node.kind !== "recipe" || !node.autoRound) continue;
      // See the header comment above — a pinned "machines"-mode limit makes
      // clock structurally unable to change the real solved machine count,
      // so there is nothing for auto-round to correct here, ever.
      if (node.limitMode === "machines" && node.limit !== null) continue;

      const nodeResult = nodeResultById.get(node.id);
      if (!nodeResult) continue; // no solve output yet for this node (None mode, or before the first solve)

      let solvedCount;
      try {
        solvedCount = parseRational(nodeResult.machineCount);
      } catch {
        continue; // defensive only — `@scm/solver` always emits canonical `n/d` strings
      }

      const currentClock = effectiveClockPercent(node);
      const snap = computeAutoRoundClock(currentClock, solvedCount);
      // The value-equality guard: `snap` is `null` when nothing needs to
      // change, and `equals(...)` catches the clamped-fixed-point case
      // where a NON-null snap still resolves to the clock already stored
      // (see `autoRound.ts`'s header + jobs/027's Handoff notes for the
      // worked example) — either way, this is what stops a write from
      // ever re-triggering itself.
      if (!snap || equals(snap.clockPercent, currentClock)) continue;

      updateNode(sfmDoc, node.id, { clock: toFractionString(snap.clockPercent) }, AUTO_ROUND_ORIGIN);
    }
  }, [sfmDoc, nodeResultById, staleness]);
}
