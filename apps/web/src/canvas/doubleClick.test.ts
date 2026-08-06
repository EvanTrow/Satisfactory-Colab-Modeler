import { describe, expect, it } from "vitest";

import { DOUBLE_CLICK_MS, DOUBLE_CLICK_PX, isDoubleClick } from "./doubleClick";

describe("isDoubleClick", () => {
  it("is false when there is no previous click", () => {
    expect(isDoubleClick(null, { time: 0, x: 0, y: 0 })).toBe(false);
  });

  it("is true for a second click within both the time and distance thresholds", () => {
    const last = { time: 1000, x: 100, y: 100 };
    const now = { time: 1000 + DOUBLE_CLICK_MS - 1, x: 100 + DOUBLE_CLICK_PX - 1, y: 100 };
    expect(isDoubleClick(last, now)).toBe(true);
  });

  it("is true at exactly the thresholds (inclusive)", () => {
    const last = { time: 1000, x: 100, y: 100 };
    const now = { time: 1000 + DOUBLE_CLICK_MS, x: 100 + DOUBLE_CLICK_PX, y: 100 };
    expect(isDoubleClick(last, now)).toBe(true);
  });

  it("is false when the second click is too slow", () => {
    const last = { time: 1000, x: 100, y: 100 };
    const now = { time: 1000 + DOUBLE_CLICK_MS + 1, x: 100, y: 100 };
    expect(isDoubleClick(last, now)).toBe(false);
  });

  it("is false when the second click is too far away", () => {
    const last = { time: 1000, x: 100, y: 100 };
    const now = { time: 1050, x: 100 + DOUBLE_CLICK_PX + 1, y: 100 };
    expect(isDoubleClick(last, now)).toBe(false);
  });

  it("respects custom thresholds", () => {
    const last = { time: 1000, x: 0, y: 0 };
    const now = { time: 1100, x: 5, y: 0 };
    expect(isDoubleClick(last, now, 50, 50)).toBe(false); // too slow for the custom 50ms window
    expect(isDoubleClick(last, now, 200, 2)).toBe(false); // too far for the custom 2px window
    expect(isDoubleClick(last, now, 200, 50)).toBe(true);
  });
});
