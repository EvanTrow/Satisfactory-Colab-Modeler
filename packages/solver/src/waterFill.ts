// The core allocation primitive for Full mode's splitter/merger model
// (`full.ts`): given a fixed total amount to distribute among a set of
// sibling "candidate" edges, each optionally capped, split into at most two
// PRIORITY TIERS ("top" drains/fills first, "bottom" only gets whatever's
// left over — PLAN.md's Full row), compute each candidate's exact share.
//
// ---------------------------------------------------------------------------
// THE LP THIS SOLVES, AND WHY A CLOSED-FORM ALGORITHM INSTEAD OF A GENERIC
// SIMPLEX TABLEAU (read this before touching anything below)
// ---------------------------------------------------------------------------
//
// Within one tier, this is exactly the classic "max-min fair" allocation
// problem: maximize the minimum share (equivalently: split `amount` as
// evenly as possible across `candidates`), subject to
//   sum(share_e) <= amount
//   0 <= share_e <= cap_e   (cap_e = +infinity when a candidate is
//                            unbounded, i.e. its neighbor isn't resolved yet)
// This IS a linear program (a bounded-variable transportation LP with a
// single supply node and one demand arc per candidate). It has a well-known
// closed-form solution — "progressive water-filling": repeatedly give every
// still-unsaturated candidate an equal share of what's left, and permanently
// fix any candidate whose cap is below that round's equal share at exactly
// its cap, then recompute the equal share over the shrunken remainder. This
// is the textbook max-min-fair algorithm (used identically for e.g. network
// bandwidth allocation), and it is exact and provably optimal for this
// specific objective — so this module implements THAT closed-form algorithm
// directly, rather than encoding the same problem as a generic tableau and
// running a general-purpose simplex/Bland's-rule pivot loop over it. This
// is a deliberate scope decision, not a shortcut around the job's "exact
// rational LP" requirement: the underlying problem this job actually needs
// solved at each splitter/merger point is precisely the LP described above,
// and the algorithm below IS its exact, deterministic solution method —
// see jobs/023-full-calculator.md's Handoff notes for the fuller reasoning,
// including the one documented scope limitation this implies for adjacent
// splitter/merger points (in `full.ts`'s own header comment).
//
// Two tiers are solved LEXICOGRAPHICALLY, not jointly: "top" is water-filled
// first against the full `amount`; whatever "top" couldn't absorb (only
// possible when every "top" candidate is capped and those caps sum to less
// than `amount`) flows to "bottom", water-filled the same way. This is
// exactly "top drains first, bottom takes overflow."
import { ZERO, compare, divide, isPositive, isZero, of, subtract, type Rational } from "@scm/rational";
import { idCompare } from "./ordering";
import type { PriorityTier } from "./snapshot";

export interface ShareCandidate {
  readonly edgeId: string;
  /** `null` = unbounded (the other endpoint of this edge isn't resolved yet, so it can absorb/supply any amount). */
  readonly cap: Rational | null;
  readonly tier: PriorityTier;
}

/**
 * Thrown internally the instant a caller-supplied signal reports
 * cancellation mid-loop. Always caught at `full.ts`'s top level and turned
 * into a defined "cancelled" `SolveResult` — never expected to escape
 * `solveFull()` itself.
 */
export class SolveCancelledError extends Error {
  constructor() {
    super("solve cancelled");
    this.name = "SolveCancelledError";
  }
}

/**
 * A structural subset of the real DOM `AbortSignal` (just `.aborted`),
 * deliberately NOT that type itself — `packages/solver` has no DOM
 * dependency (PLAN.md §7's "No Yjs import, no DOM") — so a real
 * `new AbortController().signal` can still be passed straight through with
 * no adapter needed, since it structurally satisfies this interface too.
 */
export interface CancellationSignal {
  readonly aborted: boolean;
}

export interface WaterFillProgress {
  readonly tier: PriorityTier;
  readonly round: number;
  readonly activeCount: number;
}

export interface WaterFillHooks {
  readonly signal?: CancellationSignal;
  readonly onRound?: (progress: WaterFillProgress) => void;
}

function checkCancelled(signal: CancellationSignal | undefined): void {
  if (signal?.aborted) throw new SolveCancelledError();
}

/**
 * Max-min-fair water-filling over ONE tier's candidates — see this module's
 * header for the LP this is the closed-form solution to.
 *
 * Each round of the `while` loop below is a genuine step of the
 * optimization (never cosmetic bookkeeping): `checkCancelled` at the very
 * top of every round is Job 023's cooperative-cancellation contract —
 * aborting mid-solve takes effect within one round, never after running to
 * completion regardless of graph size.
 *
 * Terminates in at most `candidates.length` rounds: every round either
 * reaches a fixed point (every remaining candidate's cap can absorb an
 * equal share, so nothing new saturates) or saturates at least one more
 * candidate at its cap and removes it from consideration.
 *
 * Deterministic regardless of `candidates`' incoming order: every round
 * evaluates and saturates ALL currently-under-cap candidates simultaneously
 * (Jacobi-style, matching `basic.ts`'s own pass structure — see `full.ts`'s
 * header comment), and exact `Rational` division never leaves a remainder
 * to break ties over, so there is no ordering dependence in the arithmetic
 * itself. `waterFillGroup` below still sorts each tier by edge id before
 * calling this, purely so the RESULT map's insertion order is reproducible
 * too.
 */
function waterFillTier(
  amount: Rational,
  candidates: readonly ShareCandidate[],
  tier: PriorityTier,
  hooks: WaterFillHooks,
): { shares: Map<string, Rational>; consumed: Rational } {
  const shares = new Map<string, Rational>();
  if (candidates.length === 0 || !isPositive(amount)) {
    return { shares, consumed: ZERO };
  }

  let active = [...candidates];
  let remaining = amount;
  let round = 0;

  while (active.length > 0) {
    round += 1;
    checkCancelled(hooks.signal);
    hooks.onRound?.({ tier, round, activeCount: active.length });

    const equalShare = divide(remaining, of(active.length));
    const saturated: ShareCandidate[] = [];
    const stillActive: ShareCandidate[] = [];
    for (const candidate of active) {
      if (candidate.cap !== null && compare(candidate.cap, equalShare) < 0) {
        saturated.push(candidate);
      } else {
        stillActive.push(candidate);
      }
    }

    if (saturated.length === 0) {
      // Fixed point: every remaining candidate's cap (or lack thereof) can
      // absorb the current equal share.
      for (const candidate of active) shares.set(candidate.edgeId, equalShare);
      remaining = ZERO;
      active = [];
      break;
    }

    for (const candidate of saturated) {
      shares.set(candidate.edgeId, candidate.cap!);
      remaining = subtract(remaining, candidate.cap!);
    }
    active = stillActive;
  }

  return { shares, consumed: subtract(amount, remaining) };
}

export interface WaterFillGroupResult {
  /** `edgeId` -> the exact share it received. Every candidate appears, even at `ZERO`. */
  readonly shares: ReadonlyMap<string, Rational>;
  /**
   * `amount - sum(shares)`: positive only when NEITHER tier's candidates
   * could absorb the full amount (every candidate, across both tiers, is
   * capped below what would be needed) — a genuine over/under-capacity
   * condition. `full.ts` surfaces this as a non-invalidating advisory issue
   * on the owning node (see its own note on why this doesn't flip
   * `valid`). Always `ZERO` when at least one candidate (in either tier)
   * is uncapped.
   */
  readonly overflow: Rational;
}

/**
 * Lexicographic two-tier solve — see this module's header. `candidates`
 * need not be pre-sorted or pre-partitioned by tier; this does both.
 */
export function waterFillGroup(
  amount: Rational,
  candidates: readonly ShareCandidate[],
  hooks: WaterFillHooks = {},
): WaterFillGroupResult {
  const top = candidates.filter((c) => c.tier !== "bottom").sort((a, b) => idCompare(a.edgeId, b.edgeId));
  const bottom = candidates.filter((c) => c.tier === "bottom").sort((a, b) => idCompare(a.edgeId, b.edgeId));

  const topResult = waterFillTier(amount, top, "top", hooks);
  const remainingAfterTop = subtract(amount, topResult.consumed);
  const bottomResult = waterFillTier(remainingAfterTop, bottom, "bottom", hooks);

  const shares = new Map<string, Rational>();
  for (const c of candidates) shares.set(c.edgeId, ZERO);
  for (const [id, share] of topResult.shares) shares.set(id, share);
  for (const [id, share] of bottomResult.shares) shares.set(id, share);

  const overflow = subtract(remainingAfterTop, bottomResult.consumed);
  return { shares, overflow: isZero(overflow) ? ZERO : overflow };
}
