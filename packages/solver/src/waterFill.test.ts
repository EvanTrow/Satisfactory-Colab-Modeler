// Direct unit tests for the max-min-fair water-filling primitive
// (`waterFill.ts`) — hand-checkable by arithmetic, independent of the
// graph-propagation machinery in `full.ts`. See `full.golden.test.ts` for
// end-to-end splitter/merger scenarios built on top of this.
import { equals, of, type Rational } from "@scm/rational";
import { describe, expect, it } from "vitest";
import { SolveCancelledError, waterFillGroup, type ShareCandidate } from "./waterFill";

function r(n: number, d = 1): Rational {
  return of(n, d);
}

describe("waterFillGroup", () => {
  it("splits evenly across uncapped candidates, all top tier by default", () => {
    const candidates: ShareCandidate[] = [
      { edgeId: "e1", cap: null, tier: "top" },
      { edgeId: "e2", cap: null, tier: "top" },
      { edgeId: "e3", cap: null, tier: "top" },
    ];
    const { shares, overflow } = waterFillGroup(r(90), candidates);
    expect(equals(shares.get("e1")!, r(30))).toBe(true);
    expect(equals(shares.get("e2")!, r(30))).toBe(true);
    expect(equals(shares.get("e3")!, r(30))).toBe(true);
    expect(equals(overflow, r(0))).toBe(true);
  });

  it("redistributes the remainder when one sibling's cap forces a smaller share than equal split", () => {
    // 90 total across 3 siblings: one capped at 10, the other two uncapped.
    // Round 1: equal share = 30 each; the capped-10 sibling is below that,
    // so it saturates at exactly 10, leaving 80 for the other two.
    // Round 2: equal share among the remaining two = 40 each; neither is
    // capped below that, so both get exactly 40.
    const candidates: ShareCandidate[] = [
      { edgeId: "capped", cap: r(10), tier: "top" },
      { edgeId: "open-a", cap: null, tier: "top" },
      { edgeId: "open-b", cap: null, tier: "top" },
    ];
    const { shares, overflow } = waterFillGroup(r(90), candidates);
    expect(equals(shares.get("capped")!, r(10))).toBe(true);
    expect(equals(shares.get("open-a")!, r(40))).toBe(true);
    expect(equals(shares.get("open-b")!, r(40))).toBe(true);
    expect(equals(overflow, r(0))).toBe(true);
    // Sanity: shares sum to the total.
    const sum = [...shares.values()].reduce((acc, v) => acc + Number(v.numerator) / Number(v.denominator), 0);
    expect(sum).toBeCloseTo(90, 10);
  });

  it("saturates multiple candidates in the same round when several are below the equal share", () => {
    // 100 total across 4 siblings, two capped at 5 each, two uncapped.
    // Round 1: equal share = 25; both capped-5 siblings are below it, so
    // BOTH saturate in the same round (not one-at-a-time) -> remaining
    // = 100 - 5 - 5 = 90 for the 2 uncapped siblings -> 45 each.
    const candidates: ShareCandidate[] = [
      { edgeId: "cap-a", cap: r(5), tier: "top" },
      { edgeId: "cap-b", cap: r(5), tier: "top" },
      { edgeId: "open-a", cap: null, tier: "top" },
      { edgeId: "open-b", cap: null, tier: "top" },
    ];
    const { shares } = waterFillGroup(r(100), candidates);
    expect(equals(shares.get("cap-a")!, r(5))).toBe(true);
    expect(equals(shares.get("cap-b")!, r(5))).toBe(true);
    expect(equals(shares.get("open-a")!, r(45))).toBe(true);
    expect(equals(shares.get("open-b")!, r(45))).toBe(true);
  });

  it("top tier drains first: an uncapped top sibling absorbs everything, bottom gets zero", () => {
    const candidates: ShareCandidate[] = [
      { edgeId: "top-a", cap: null, tier: "top" },
      { edgeId: "bottom-a", cap: null, tier: "bottom" },
    ];
    const { shares } = waterFillGroup(r(60), candidates);
    expect(equals(shares.get("top-a")!, r(60))).toBe(true);
    expect(equals(shares.get("bottom-a")!, r(0))).toBe(true);
  });

  it("bottom tier takes exactly the overflow once top tier's cap is exhausted", () => {
    // Single top-tier edge capped at 20; single bottom-tier edge uncapped.
    // Top absorbs 20 (its cap), the remaining 40 flows entirely to bottom.
    const candidates: ShareCandidate[] = [
      { edgeId: "top-a", cap: r(20), tier: "top" },
      { edgeId: "bottom-a", cap: null, tier: "bottom" },
    ];
    const { shares, overflow } = waterFillGroup(r(60), candidates);
    expect(equals(shares.get("top-a")!, r(20))).toBe(true);
    expect(equals(shares.get("bottom-a")!, r(40))).toBe(true);
    expect(equals(overflow, r(0))).toBe(true);
  });

  it("splits evenly within a tier that has multiple members, once cap-limited siblings are set aside", () => {
    // 90 total, 2 top-tier edges (uncapped) + 1 bottom-tier edge (uncapped)
    // -> top absorbs everything evenly (45 each), bottom gets 0.
    const candidates: ShareCandidate[] = [
      { edgeId: "top-a", cap: null, tier: "top" },
      { edgeId: "top-b", cap: null, tier: "top" },
      { edgeId: "bottom-a", cap: null, tier: "bottom" },
    ];
    const { shares } = waterFillGroup(r(90), candidates);
    expect(equals(shares.get("top-a")!, r(45))).toBe(true);
    expect(equals(shares.get("top-b")!, r(45))).toBe(true);
    expect(equals(shares.get("bottom-a")!, r(0))).toBe(true);
  });

  it("reports overflow when every candidate across both tiers is capped below the total", () => {
    const candidates: ShareCandidate[] = [
      { edgeId: "top-a", cap: r(10), tier: "top" },
      { edgeId: "bottom-a", cap: r(5), tier: "bottom" },
    ];
    const { shares, overflow } = waterFillGroup(r(100), candidates);
    expect(equals(shares.get("top-a")!, r(10))).toBe(true);
    expect(equals(shares.get("bottom-a")!, r(5))).toBe(true);
    expect(equals(overflow, r(85))).toBe(true);
  });

  it("is exact under fractional caps (no rounding remainder)", () => {
    // 1 total across 3 uncapped siblings -> exactly 1/3 each, not a
    // repeating-decimal approximation.
    const candidates: ShareCandidate[] = [
      { edgeId: "a", cap: null, tier: "top" },
      { edgeId: "b", cap: null, tier: "top" },
      { edgeId: "c", cap: null, tier: "top" },
    ];
    const { shares } = waterFillGroup(r(1), candidates);
    expect(equals(shares.get("a")!, of(1, 3))).toBe(true);
    expect(equals(shares.get("b")!, of(1, 3))).toBe(true);
    expect(equals(shares.get("c")!, of(1, 3))).toBe(true);
  });

  it("checks cancellation at the start of every round and throws SolveCancelledError promptly, not after running to completion", () => {
    // A hand-verified 3-round staircase: caps 1, 2, 4 plus one uncapped
    // sibling, total 8.
    //   Round 1: equalShare = 8/4 = 2. Only cap=1 is < 2 -> saturates at 1.
    //   Round 2: remaining = 7, 3 active, equalShare = 7/3. Only cap=2 is
    //            < 7/3 (2.333...) -> saturates at 2.
    //   Round 3: remaining = 5, 2 active (cap=4, uncapped),
    //            equalShare = 5/2 = 2.5. cap=4 is NOT < 2.5 -> fixed point,
    //            both remaining candidates get 2.5 each. Done in 3 rounds.
    const candidates: ShareCandidate[] = [
      { edgeId: "cap-1", cap: r(1), tier: "top" },
      { edgeId: "cap-2", cap: r(2), tier: "top" },
      { edgeId: "cap-4", cap: r(4), tier: "top" },
      { edgeId: "open", cap: null, tier: "top" },
    ];

    // Uncancelled: confirm it genuinely takes all 3 rounds (so the
    // cancellation test below is provably cutting real work short, not
    // just observing a scenario that would have finished in 1 round
    // anyway).
    let uncancelledRounds = 0;
    const completed = waterFillGroup(r(8), candidates, { onRound: () => (uncancelledRounds += 1) });
    expect(uncancelledRounds).toBe(3);
    expect(equals(completed.shares.get("cap-1")!, r(1))).toBe(true);
    expect(equals(completed.shares.get("cap-2")!, r(2))).toBe(true);
    expect(equals(completed.shares.get("cap-4")!, of(5, 2))).toBe(true);
    expect(equals(completed.shares.get("open")!, of(5, 2))).toBe(true);

    // Cancel right after round 1's callback fires — round 2 should never
    // report progress at all, since `checkCancelled` runs at the TOP of
    // round 2, before that round's own `onRound` call.
    let cancelledRounds = 0;
    const signal = { aborted: false };
    expect(() =>
      waterFillGroup(r(8), candidates, {
        signal,
        onRound: () => {
          cancelledRounds += 1;
          if (cancelledRounds === 1) signal.aborted = true;
        },
      }),
    ).toThrow(SolveCancelledError);
    expect(cancelledRounds).toBe(1);
    expect(cancelledRounds).toBeLessThan(uncancelledRounds);
  });

  it("throws immediately, before doing any work, when the signal is already aborted", () => {
    const candidates: ShareCandidate[] = [
      { edgeId: "a", cap: null, tier: "top" },
      { edgeId: "b", cap: null, tier: "top" },
    ];
    let calls = 0;
    expect(() =>
      waterFillGroup(r(10), candidates, { signal: { aborted: true }, onRound: () => (calls += 1) }),
    ).toThrow(SolveCancelledError);
    expect(calls).toBe(0);
  });
});
