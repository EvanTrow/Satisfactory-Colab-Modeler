import { describe, expect, it } from "vitest";

import {
  nodeBoundsRect,
  polylineIntersectsRect,
  type Rect,
  rectFromPoints,
  rectsIntersect,
  segmentIntersectsRect,
} from "./marqueeGeometry";

describe("rectFromPoints", () => {
  it("normalizes a top-left-to-bottom-right drag", () => {
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 110, y: 220 })).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it("normalizes a bottom-right-to-top-left drag (reverse direction)", () => {
    expect(rectFromPoints({ x: 110, y: 220 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it("handles a zero-size drag (a click with no movement)", () => {
    expect(rectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });
});

describe("rectsIntersect", () => {
  const marquee: Rect = { x: 0, y: 0, width: 100, height: 100 };

  it("is true for full containment", () => {
    expect(rectsIntersect(marquee, { x: 10, y: 10, width: 20, height: 20 })).toBe(true);
  });

  it("is true for partial overlap (Partial-containment semantics — touching counts)", () => {
    expect(rectsIntersect(marquee, { x: 90, y: 90, width: 50, height: 50 })).toBe(true);
  });

  it("is false when entirely outside", () => {
    expect(rectsIntersect(marquee, { x: 200, y: 200, width: 20, height: 20 })).toBe(false);
  });

  it("is false for two rects that only touch at the edge with zero overlap area", () => {
    expect(rectsIntersect(marquee, { x: 100, y: 0, width: 20, height: 20 })).toBe(false);
  });
});

describe("nodeBoundsRect", () => {
  it("builds a top-left-anchored rect from position + size", () => {
    expect(nodeBoundsRect({ x: 50, y: 60 }, { width: 256, height: 120 })).toEqual({
      x: 50,
      y: 60,
      width: 256,
      height: 120,
    });
  });
});

describe("segmentIntersectsRect", () => {
  const rect: Rect = { x: 0, y: 0, width: 100, height: 100 };

  it("is true when an endpoint is inside the rect", () => {
    expect(segmentIntersectsRect({ x: 50, y: 50 }, { x: 500, y: 500 }, rect)).toBe(true);
  });

  it("is true when the segment passes through the rect without either endpoint inside it", () => {
    expect(segmentIntersectsRect({ x: -50, y: 50 }, { x: 150, y: 50 }, rect)).toBe(true);
  });

  it("is false when the segment is entirely outside and doesn't cross any edge", () => {
    expect(segmentIntersectsRect({ x: 200, y: 200 }, { x: 300, y: 300 }, rect)).toBe(false);
  });

  it("is false for a parallel segment that never reaches the rect", () => {
    expect(segmentIntersectsRect({ x: -50, y: 500 }, { x: 500, y: 500 }, rect)).toBe(false);
  });
});

describe("polylineIntersectsRect", () => {
  const rect: Rect = { x: 0, y: 0, width: 100, height: 100 };

  it("is false for an empty polyline", () => {
    expect(polylineIntersectsRect([], rect)).toBe(false);
  });

  it("degenerates to a point-in-rect test for a single point", () => {
    expect(polylineIntersectsRect([{ x: 50, y: 50 }], rect)).toBe(true);
    expect(polylineIntersectsRect([{ x: 500, y: 500 }], rect)).toBe(false);
  });

  it("is true when a later segment (not the first) crosses the rect — waypoints routed through it", () => {
    const points = [
      { x: -200, y: -200 }, // source, far outside
      { x: -200, y: 50 }, // waypoint 1, still outside
      { x: 50, y: 50 }, // waypoint 2, inside — the segment leading into it crosses the rect
      { x: 500, y: 500 }, // target, outside
    ];
    expect(polylineIntersectsRect(points, rect)).toBe(true);
  });

  it("is false when every segment stays clear of the rect", () => {
    const points = [
      { x: -200, y: -200 },
      { x: -200, y: 500 },
      { x: 500, y: 500 },
    ];
    expect(polylineIntersectsRect(points, rect)).toBe(false);
  });
});
