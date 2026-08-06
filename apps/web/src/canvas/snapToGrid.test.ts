import { describe, expect, it } from "vitest";

import { snapPointToGrid, snapToGrid } from "./snapToGrid";

describe("snapToGrid", () => {
  it("snaps to the nearest multiple of gridSize", () => {
    expect(snapToGrid(103, 100)).toBe(100);
    expect(snapToGrid(150, 100)).toBe(200); // Math.round ties toward +Infinity
    expect(snapToGrid(149, 100)).toBe(100);
    expect(snapToGrid(0, 100)).toBe(0);
  });

  it("handles negative values symmetrically", () => {
    expect(snapToGrid(-103, 100)).toBe(-100);
    expect(snapToGrid(-149, 100)).toBe(-100);
    expect(snapToGrid(-151, 100)).toBe(-200);
  });

  it("is a no-op for values already exactly on the grid", () => {
    expect(snapToGrid(200, 50)).toBe(200);
    expect(snapToGrid(-50, 50)).toBe(-50);
  });

  it("passes the value through unchanged when gridSize is 0 or negative (defensive — disables snapping rather than dividing by zero)", () => {
    expect(snapToGrid(123.456, 0)).toBe(123.456);
    expect(snapToGrid(123.456, -10)).toBe(123.456);
  });

  it("passes the value through unchanged when gridSize is non-finite", () => {
    expect(snapToGrid(123, NaN)).toBe(123);
    expect(snapToGrid(123, Infinity)).toBe(123);
  });

  it("works for a fine waypoint-sized grid too, not just machine-sized", () => {
    expect(snapToGrid(23, 25)).toBe(25);
    expect(snapToGrid(12, 25)).toBe(0);
  });
});

describe("snapPointToGrid", () => {
  it("snaps x and y independently against a possibly-non-square grid", () => {
    expect(snapPointToGrid({ x: 103, y: 74 }, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
  });

  it("leaves an axis untouched when that axis's grid size is 0", () => {
    expect(snapPointToGrid({ x: 103, y: 74.25 }, { x: 100, y: 0 })).toEqual({ x: 100, y: 74.25 });
  });
});
