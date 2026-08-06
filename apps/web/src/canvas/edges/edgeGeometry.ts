// Pure, React/React-Flow-free geometry helpers for rendering and editing a
// polyline connection (source -> waypoints -> target). Kept separate from
// `ConnectionEdge.tsx` so it's unit-testable without any DOM/React Flow
// setup, same pattern Jobs 009/010 used for `filters.ts`/`recipeNodeMath.ts`.
//
// Coordinate space: every `Point` here is in React Flow's "flow" coordinate
// space (the same space `NodeRecord.x`/`.y` and `Waypoint.x`/`.y` live in),
// never raw screen/client pixels — callers convert screen coordinates via
// `useReactFlow().screenToFlowPosition` *before* calling into this module,
// same convention Job 009's Recipe Chooser established for node placement.
export interface Point {
  x: number;
  y: number;
}

/** `[source, ...waypoints, target]`, in path order. */
export function buildPolyline(source: Point, waypoints: readonly Point[], target: Point): Point[] {
  return [source, ...waypoints, target];
}

function segmentLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += segmentLength(points[i]!, points[i + 1]!);
  }
  return total;
}

/**
 * The point at fractional arc-length `t` (clamped to `[0, 1]`) along an
 * ordered polyline — the geometry behind `EdgeRecord.labelPos`'s confirmed
 * "0..1 t-parameter along the edge's path" convention (see this job's
 * Handoff notes). Degenerates gracefully for a zero-length or single-point
 * polyline rather than dividing by zero.
 */
export function pointAtT(points: readonly Point[], t: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;

  const clampedT = Math.min(1, Math.max(0, t));
  const total = polylineLength(points);
  if (total === 0) return points[0]!;

  const targetDistance = clampedT * total;
  let travelled = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const segLen = segmentLength(a, b);
    const isLastSegment = i === points.length - 2;
    if (travelled + segLen >= targetDistance || isLastSegment) {
      const fraction = segLen === 0 ? 0 : Math.min(1, Math.max(0, (targetDistance - travelled) / segLen));
      return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
    }
    travelled += segLen;
  }
  return points[points.length - 1]!;
}

/** Shortest distance from `point` to the (clamped) segment `a`-`b`. */
function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);

  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  const projectedX = a.x + t * dx;
  const projectedY = a.y + t * dy;
  return Math.hypot(point.x - projectedX, point.y - projectedY);
}

/**
 * Index of the polyline segment (0-based, connecting `points[i]` to
 * `points[i + 1]`) nearest to `click`. This doubles as the correct
 * `addWaypoint(sfmDoc, edgeId, point, index)` insertion index into the
 * *waypoints-only* array: `points` is `[source, ...waypoints, target]`, so
 * "insert into segment `i`" means "insert at `waypoints` index `i`",
 * including `i === waypoints.length` for the final segment (append just
 * before `target`) — which is exactly `addWaypoint`'s own default when
 * `index` is omitted, so a click near the last segment behaves identically
 * either way.
 */
export function nearestSegmentIndex(points: readonly Point[], click: Point): number {
  if (points.length < 2) return 0;
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const distance = distanceToSegment(click, points[i]!, points[i + 1]!);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** `M x0 y0 L x1 y1 L x2 y2 ...` — a straight-segment SVG path through every point in order. */
export function toPathD(points: readonly Point[]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points as [Point, ...Point[]];
  return `M ${first.x} ${first.y} ${rest.map((p) => `L ${p.x} ${p.y}`).join(" ")}`.trimEnd();
}
