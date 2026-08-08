// Job 027: pure decision math for PLAN.md §2's Auto-round feature —
// "Toggle that continuously solves clock speed so machine count is a whole
// number." Deliberately its own module (not folded into
// `recipeNodeMath.ts`) even though it leans on that file's
// `deriveClockForTargetCount` — this is genuinely different math from the
// manual ± buttons (which step through a fixed `CLOCK_PRESETS` list, no
// solving involved), not just a thin wrapper, and keeping it separate
// matches every prior canvas job's pattern of extracting pure,
// independently-testable logic into its own file (recipeNodeMath.ts itself,
// edgeGeometry.ts, snapToGrid.ts, splurgerPassthrough.ts, ...).
//
// ---------------------------------------------------------------------------
// Why NEAREST rounding, not directional
// ---------------------------------------------------------------------------
// A manual ± button click has an obvious direction (up or down the preset
// list) because the click itself IS the direction. Auto-round has no click
// to read a direction from — it fires from a graph recompute, not a user
// gesture — so "which whole number do I snap to" has to be answered some
// other way. Nearest-with-ties-up is the least surprising choice: it
// minimizes how far the clock has to move away from whatever the graph's
// real demand implies, and it's stable (see below) in exactly the same way
// a directional snap would be, just without importing a direction the
// caller doesn't have.
//
// ---------------------------------------------------------------------------
// The convergence/stability argument — the load-bearing part of this file
// ---------------------------------------------------------------------------
// `useAutoRound.ts` calls `computeAutoRoundClock` every time a *settled*
// solve result lands for an auto-round-enabled node, and writes the result
// straight back to `NodeRecord.clock`. That write itself changes the doc,
// which re-triggers a solve (Job 018's debounce) — so this function's
// output has to be a genuine fixed point, or the app would sit in a
// 150ms-interval write loop forever. It is one, for a structural reason:
//
//   A recipe node's own clock speed can change how MANY machines are needed
//   to hit a given target rate, but it can never change what that target
//   rate itself IS. `recipeNodeMath.ts`'s `computeMachineCount` derivation
//   makes this exact: for any part `p`,
//
//     rate_p  = machineCount × ratePerMachineAtFullClock(p) × clock/100
//     machineCount = targetRate_primary / (referenceRate_primary × clock/100)
//
//   Substituting the second into the first, `clock/100` cancels completely:
//
//     rate_p = targetRate_primary × ratePerMachineAtFullClock(p) / referenceRate_primary
//
//   — independent of clock. This holds for EVERY part of the recipe,
//   including the primary part itself, and it holds regardless of whether
//   `targetRate_primary` came from this node's own pinned `limit` or from
//   `@scm/solver`'s Basic/Full-mode graph propagation (Job 017/023's
//   `nodeProfile.ts` uses this exact same per-node formula in every mode —
//   see jobs/017's Handoff notes, "the per-node math doesn't change" between
//   Basic and Full). So changing ONE node's clock can never change what rate
//   it produces/consumes for any part, which means it can never change what
//   any OTHER node infers via propagation (Basic mode's `propagateMachineCounts`
//   and Full mode's water-filling both only ever look at RATES on shared
//   edges, never at a neighbor's machine count) — and, by the same
//   argument applied to itself, it can't change what target rate THIS node
//   re-derives on the next solve either.
//
//   Concretely: writing `newClock` here is chosen so that
//   `targetRate_primary / (referenceRate_primary × newClock/100)` equals
//   exactly the intended whole target count (or, if that target fell
//   outside `[MIN_CLOCK_PERCENT, MAX_CLOCK_PERCENT]`, the genuine clamped
//   count `deriveClockForTargetCount` already computed). Since
//   `targetRate_primary` provably can't have changed, the NEXT solve
//   reproduces that exact same machine count — and re-running
//   `computeAutoRoundClock` against that reproduced count either (a) sees
//   an already-whole count and returns `null` (done, no further write), or
//   (b) in the clamped case, re-derives the SAME clamped clock it already
//   holds, which `useAutoRound.ts`'s `equals()` guard recognizes as a no-op.
//   Either way, at most one real write follows the settling of any given
//   upstream change — never an unbounded loop. See `useAutoRound.ts`'s own
//   header for the write-source/guard side of this argument, and
//   jobs/027-polish-misc.md's Handoff notes for the full write-up (including
//   the worked clamped-fixed-point example).
import { ONE, compare, fromBigInt, isNegative, isZero, of, subtract, type Rational } from "@scm/rational";

import {
  deriveClockForTargetCount,
  floorToBigInt,
  isIntegerRational,
  type ClockSnapResult,
} from "./recipeNodeMath";

const HALF: Rational = of(1, 2);

/**
 * Rounds `count` to the nearest whole number (ties round up/away from the
 * floor), clamped to a minimum of exactly `1` — a factory can't run a zero
 * or negative number of machines.
 */
export function nearestWholeMachineCount(count: Rational): Rational {
  const floor = floorToBigInt(count);
  const remainder = subtract(count, fromBigInt(floor));
  const rounded = compare(remainder, HALF) >= 0 ? floor + 1n : floor;
  return fromBigInt(rounded < 1n ? 1n : rounded);
}

/**
 * The auto-round decision for one node, given its current clock and the
 * LIVE solved machine count (`NodeSolveResult.machineCount`, parsed by the
 * caller — see `useAutoRound.ts`). Returns `null` when there's genuinely
 * nothing to do: already a whole number (≥ 1), or a degenerate zero/negative
 * input this function can't anchor the count∝1/clock relationship on.
 */
export function computeAutoRoundClock(
  currentClockPercent: Rational,
  currentMachineCount: Rational,
): ClockSnapResult | null {
  if (isZero(currentClockPercent) || isZero(currentMachineCount) || isNegative(currentMachineCount)) {
    return null;
  }
  if (isIntegerRational(currentMachineCount) && compare(currentMachineCount, ONE) >= 0) {
    return null;
  }

  const target = nearestWholeMachineCount(currentMachineCount);
  return deriveClockForTargetCount(currentClockPercent, currentMachineCount, target);
}
