import { describe, expect, it } from "vitest";

import { PHASE_MAX_TIER, PROGRESSION_PHASES, isValidProgressionSelection, maxTierForPhase } from "./progression";

describe("maxTierForPhase", () => {
  it("matches the game's delivery-unlock table for each phase", () => {
    expect(maxTierForPhase(1)).toBe(4);
    expect(maxTierForPhase(2)).toBe(6);
    expect(maxTierForPhase(3)).toBe(8);
    expect(maxTierForPhase(4)).toBe(9);
    expect(maxTierForPhase(5)).toBe(9);
  });

  it("imposes no cap (Tier 9) when no phase is set", () => {
    expect(maxTierForPhase(null)).toBe(9);
  });
});

describe("PROGRESSION_PHASES", () => {
  it("lists phases 1-5, sorted", () => {
    expect(PROGRESSION_PHASES).toEqual([1, 2, 3, 4, 5]);
  });

  it("matches PHASE_MAX_TIER's own keys", () => {
    expect(PROGRESSION_PHASES).toEqual(Object.keys(PHASE_MAX_TIER).map(Number).sort((a, b) => a - b));
  });
});

describe("isValidProgressionSelection", () => {
  it("is always valid when either side is unset", () => {
    expect(isValidProgressionSelection(null, null)).toBe(true);
    expect(isValidProgressionSelection(9, null)).toBe(true);
    expect(isValidProgressionSelection(null, 1)).toBe(true);
  });

  it("accepts a tier at or below the phase's max", () => {
    expect(isValidProgressionSelection(4, 1)).toBe(true);
    expect(isValidProgressionSelection(0, 1)).toBe(true);
    expect(isValidProgressionSelection(9, 4)).toBe(true);
    expect(isValidProgressionSelection(9, 5)).toBe(true);
  });

  it("rejects a tier above the phase's max", () => {
    expect(isValidProgressionSelection(5, 1)).toBe(false);
    expect(isValidProgressionSelection(9, 1)).toBe(false);
    expect(isValidProgressionSelection(7, 2)).toBe(false);
  });
});
