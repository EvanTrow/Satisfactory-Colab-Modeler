// Pure, React-free rectangle/segment geometry backing the right-click-drag
// marquee (Job 012 — see PLAN.md §2's "Select" row and §3's "marquee
// select"). Kept dependency-free and framework-free, same pattern
// `edges/edgeGeometry.ts` established in Job 011, so it's directly
// unit-testable without mounting React Flow or touching a real Yjs doc.
//
// Coordinate-system agnostic: every function here takes plain `{x,y}`
// points/rects and doesn't care whether they're screen (client) pixels or
// React Flow's flow/document coordinates — `useMarqueeSelection.ts` is the
// only place that knows which is which (screen space for rendering the
// overlay div, flow space for the actual node/edge hit-testing).

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalizes two arbitrary corner points (in either drag direction) into a top-left-anchored, non-negative-size `Rect`. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Standard axis-aligned-bounding-box overlap test (`Partial`-containment semantics — a node only needs to touch the marquee, not sit fully inside it, to be selected). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Builds a node's bounding `Rect` from its top-left position and measured (or fallback) size — React Flow node positions are always top-left-anchored (`nodeOrigin` defaults to `[0, 0]`, unchanged anywhere in this codebase). */
export function nodeBoundsRect(position: Point, size: { width: number; height: number }): Rect {
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function onSegment(p: Point, q: Point, r: Point): boolean {
  return (
    Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) && Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y)
  );
}

/** Standard orientation-based segment/segment intersection test (handles the collinear-overlap edge case via `onSegment`). */
function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(p3, p1, p4)) return true;
  if (d2 === 0 && onSegment(p3, p2, p4)) return true;
  if (d3 === 0 && onSegment(p1, p3, p2)) return true;
  if (d4 === 0 && onSegment(p1, p4, p2)) return true;
  return false;
}

/** True if the segment `p1`→`p2` touches `rect` at all — either endpoint lands inside it, or the segment crosses one of its four edges. */
export function segmentIntersectsRect(p1: Point, p2: Point, rect: Rect): boolean {
  if (pointInRect(p1, rect) || pointInRect(p2, rect)) return true;
  const { x, y, width, height } = rect;
  const topLeft = { x, y };
  const topRight = { x: x + width, y };
  const bottomRight = { x: x + width, y: y + height };
  const bottomLeft = { x, y: y + height };
  return (
    segmentsIntersect(p1, p2, topLeft, topRight) ||
    segmentsIntersect(p1, p2, topRight, bottomRight) ||
    segmentsIntersect(p1, p2, bottomRight, bottomLeft) ||
    segmentsIntersect(p1, p2, bottomLeft, topLeft)
  );
}

/** True if any segment of the polyline `points` (in order — e.g. `[sourceCenter, ...waypoints, targetCenter]`) touches `rect`. Degenerates to a point-in-rect test for a single-point "polyline". */
export function polylineIntersectsRect(points: readonly Point[], rect: Rect): boolean {
  if (points.length === 0) return false;
  if (points.length === 1) return pointInRect(points[0] as Point, rect);
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i] as Point;
    const to = points[i + 1] as Point;
    if (segmentIntersectsRect(from, to, rect)) return true;
  }
  return false;
}
