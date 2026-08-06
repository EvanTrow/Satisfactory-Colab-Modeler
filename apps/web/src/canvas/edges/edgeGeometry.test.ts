import { describe, expect, it } from "vitest";

import { buildPolyline, nearestSegmentIndex, pointAtT, polylineLength, toPathD } from "./edgeGeometry";

const A = { x: 0, y: 0 };
const B = { x: 100, y: 0 };
const C = { x: 100, y: 100 };

describe("buildPolyline", () => {
  it("orders source, waypoints, target", () => {
    expect(buildPolyline(A, [B], C)).toEqual([A, B, C]);
  });

  it("handles zero waypoints", () => {
    expect(buildPolyline(A, [], C)).toEqual([A, C]);
  });
});

describe("polylineLength", () => {
  it("sums straight-line segment lengths", () => {
    // A->B is 100, B->C is 100: total 200.
    expect(polylineLength([A, B, C])).toBeCloseTo(200);
  });

  it("is 0 for a single point", () => {
    expect(polylineLength([A])).toBe(0);
  });

  it("matches a 3-4-5 triangle for a direct two-point line", () => {
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBeCloseTo(5);
  });
});

describe("pointAtT", () => {
  it("returns the source at t=0 and the target at t=1 for a direct edge", () => {
    expect(pointAtT([A, C], 0)).toEqual(A);
    expect(pointAtT([A, C], 1)).toEqual(C);
  });

  it("returns the midpoint at t=0.5 for a direct edge", () => {
    expect(pointAtT([A, C], 0.5)).toEqual({ x: 50, y: 50 });
  });

  it("walks through multiple segments proportionally to arc length", () => {
    // A->B->C: 100 then 100, total 200. t=0.25 is 50 units in, still on the first (A->B) segment.
    expect(pointAtT([A, B, C], 0.25)).toEqual({ x: 50, y: 0 });
    // t=0.75 is 150 units in: 100 along A->B, then 50 more along B->C.
    expect(pointAtT([A, B, C], 0.75)).toEqual({ x: 100, y: 50 });
  });

  it("clamps t outside [0, 1]", () => {
    expect(pointAtT([A, C], -1)).toEqual(A);
    expect(pointAtT([A, C], 2)).toEqual(C);
  });

  it("degenerates gracefully for a zero-length polyline", () => {
    expect(pointAtT([A, A], 0.5)).toEqual(A);
  });

  it("returns the only point for a single-point polyline", () => {
    expect(pointAtT([A], 0.5)).toEqual(A);
  });
});

describe("nearestSegmentIndex", () => {
  it("picks segment 0 for a click near the first leg", () => {
    // A(0,0)->B(100,0)->C(100,100): a click near (50, 1) is on the A->B leg.
    expect(nearestSegmentIndex([A, B, C], { x: 50, y: 1 })).toBe(0);
  });

  it("picks the last segment for a click near the final leg", () => {
    expect(nearestSegmentIndex([A, B, C], { x: 101, y: 50 })).toBe(1);
  });

  it("returns 0 (append) for a direct edge with no waypoints", () => {
    expect(nearestSegmentIndex([A, C], { x: 50, y: 51 })).toBe(0);
  });

  it("returns 0 for a degenerate single-point polyline", () => {
    expect(nearestSegmentIndex([A], { x: 999, y: 999 })).toBe(0);
  });
});

describe("toPathD", () => {
  it("builds an M/L path through every point in order", () => {
    expect(toPathD([A, B, C])).toBe("M 0 0 L 100 0 L 100 100");
  });

  it("is empty for no points", () => {
    expect(toPathD([])).toBe("");
  });
});
