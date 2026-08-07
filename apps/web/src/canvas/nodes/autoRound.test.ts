import { ONE, ZERO, equals, negate, of } from "@scm/rational";
import { describe, expect, it } from "vitest";

import { deriveClockForTargetCount, MAX_CLOCK_PERCENT, MIN_CLOCK_PERCENT } from "./recipeNodeMath";
import { computeAutoRoundClock, nearestWholeMachineCount } from "./autoRound";

describe("nearestWholeMachineCount", () => {
  it("rounds down below the halfway point", () => {
    expect(equals(nearestWholeMachineCount(of(10, 3)), of(3))).toBe(true); // 3.333
  });

  it("rounds up at/above the halfway point (ties round up)", () => {
    expect(equals(nearestWholeMachineCount(of(7, 2)), of(4))).toBe(true); // 3.5 exactly
    expect(equals(nearestWholeMachineCount(of(11, 3)), of(4))).toBe(true); // 3.666
  });

  it("leaves an already-whole count unchanged", () => {
    expect(equals(nearestWholeMachineCount(of(5)), of(5))).toBe(true);
  });

  it("floors at exactly 1 — never rounds to 0 or negative", () => {
    expect(equals(nearestWholeMachineCount(of(1, 4)), ONE)).toBe(true);
    expect(equals(nearestWholeMachineCount(ZERO), ONE)).toBe(true);
    expect(equals(nearestWholeMachineCount(negate(of(3))), ONE)).toBe(true);
  });
});

describe("computeAutoRoundClock", () => {
  it("returns null when the machine count is already whole (nothing to do)", () => {
    expect(computeAutoRoundClock(of(100), of(4))).toBeNull();
  });

  it("returns null for a degenerate zero clock or zero/negative count", () => {
    expect(computeAutoRoundClock(ZERO, of(4))).toBeNull();
    expect(computeAutoRoundClock(of(100), ZERO)).toBeNull();
    expect(computeAutoRoundClock(of(100), negate(of(2)))).toBeNull();
  });

  it("snaps to the NEAREST whole count, not a directional one", () => {
    // 3.333 machines at 100% clock -> nearest is 3, not 4 (which is what
    // the manual "-" button's roundUp direction would have picked).
    const result = computeAutoRoundClock(of(100), of(10, 3))!;
    expect(result).not.toBeNull();
    expect(equals(result.machineCount, of(3))).toBe(true);
    expect(result.clamped).toBe(false);
    // Cross-check against the shared core directly: this is exactly what
    // `deriveClockForTargetCount(100, 10/3, 3)` computes — the whole point
    // of sharing that helper with `snapClockToWholeMachineCount`.
    expect(equals(result.clockPercent, deriveClockForTargetCount(of(100), of(10, 3), of(3)).clockPercent)).toBe(
      true,
    );
  });

  it("snaps a tie (exactly .5) up", () => {
    const result = computeAutoRoundClock(of(100), of(7, 2))!; // 3.5 machines
    expect(equals(result.machineCount, of(4))).toBe(true);
  });

  it("full round trip: the fixed point holds — re-evaluating against the post-write (clock, count) needs no further write", () => {
    const currentClock = of(80);
    const currentCount = of(37, 5); // 7.4 machines
    const result = computeAutoRoundClock(currentClock, currentCount)!;
    expect(result.clamped).toBe(false);
    expect(equals(result.machineCount, of(7))).toBe(true); // nearest(7.4) = 7

    // Re-evaluating with the NEW (clock, count) pair — exactly what the next
    // real solve would hand `useAutoRound.ts` once the write has taken
    // effect, per this module's own "clock never changes rates" argument —
    // must see an already-whole count and do nothing further. This is the
    // no-oscillation guarantee, proven directly rather than just asserted.
    expect(computeAutoRoundClock(result.clockPercent, result.machineCount)).toBeNull();
  });

  it("clamps to MIN_CLOCK_PERCENT when the nearest target would need an out-of-range clock, and stabilizes there (no oscillation)", () => {
    // A tiny current count (0.005 at 100% clock) rounds to a target of 1,
    // which would need clock = 100 * 0.005/1 = 0.5% — below the 1% floor.
    const first = computeAutoRoundClock(of(100), of(5, 1000))!;
    expect(first.clamped).toBe(true);
    expect(equals(first.clockPercent, MIN_CLOCK_PERCENT)).toBe(true);
    expect(equals(first.machineCount, of(1, 2))).toBe(true); // 0.5 machines at the clamped 1% clock

    // Re-running against the settled (clamped, still non-whole) result must
    // be a genuine fixed point: it computes the SAME clamped clock again
    // (not a different one), which is what `useAutoRound.ts`'s
    // `equals()` guard relies on to stop writing.
    const second = computeAutoRoundClock(first.clockPercent, first.machineCount)!;
    expect(second.clamped).toBe(true);
    expect(equals(second.clockPercent, first.clockPercent)).toBe(true);
  });

  it("clamps to MAX_CLOCK_PERCENT symmetrically, and also stabilizes there", () => {
    // 1.4 machines at 200% clock rounds down to a target of 1 (remainder
    // 0.4 < 0.5), which would need clock = 200 * 1.4/1 = 280% — above the
    // 250% cap.
    const first = computeAutoRoundClock(of(200), of(7, 5))!;
    expect(first.clamped).toBe(true);
    expect(equals(first.clockPercent, MAX_CLOCK_PERCENT)).toBe(true);

    const second = computeAutoRoundClock(first.clockPercent, first.machineCount)!;
    expect(second.clamped).toBe(true);
    expect(equals(second.clockPercent, first.clockPercent)).toBe(true);
  });
});
