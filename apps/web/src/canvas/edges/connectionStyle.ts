// Job 027: connection style rendering — PLAN.md §3's "connection style
// options (Direct/Curves/Horizontal)", wired to `@scm/ydoc`'s already-
// existing `Settings.connectionStyle`/`EdgeRecord.style` (Job 007's schema).
// Pure geometry, kept separate from `edgeGeometry.ts` (Job 011's straight-
// polyline math, which this module reuses conceptually but not by import —
// see below) so it's independently unit-testable without any DOM/React Flow
// setup, following every prior canvas job's pattern.
//
// ---------------------------------------------------------------------------
// Naming reconciliation — PLAN.md's UI copy vs. `@scm/ydoc`'s schema enum
// ---------------------------------------------------------------------------
// PLAN.md's own wording names three *user-facing* options — Direct / Curves /
// Horizontal — but `ConnectionStyleSchema` (`packages/ydoc/src/schema.ts`)
// types the field as React-Flow-native names: `"straight" | "step" |
// "bezier"`. The fourth original option ("Vertical" / `"smoothstep"`) was
// removed by user request — it duplicated Horizontal's orthogonal-routing
// shape with only the axis and corner-rounding differing, and wasn't worth
// the extra option. Mapping this file (and `SettingsMenu.tsx`, which shows
// the PLAN.md-facing labels) commits to:
//
//   Direct     -> "straight"    literal straight-line segments through
//                                every waypoint — Job 011's original,
//                                unchanged rendering.
//   Curves     -> "bezier"      a smooth curve interpolated THROUGH every
//                                waypoint (Catmull-Rom-derived cubic
//                                Bezier control points — see `bezierPath`
//                                below), not an approximation that skips
//                                waypoints.
//   Horizontal -> "step"        orthogonal (right-angle) routing whose
//                                first and last legs out of each endpoint
//                                are HORIZONTAL, sharp corners.
//
// ---------------------------------------------------------------------------
// Precedence: per-edge `EdgeRecord.style` vs. document-wide `Settings.connectionStyle`
// ---------------------------------------------------------------------------
// `resolveConnectionStyle` below implements the precedence this job commits
// to: a valid per-edge `EdgeRecord.style` always wins; `null`/`undefined`/an
// unrecognized string falls back to the document-wide default. This mirrors
// the identical precedence `EdgeRecord.labelPos`/`.waypoints` already use
// relative to their own "unset" sentinel (Job 007/011) — a per-edge override
// when present, a document/computed default otherwise — so it's not a new
// convention, just this field's first real consumer. No UI was built to
// actually SET a per-edge override (`SettingsMenu.tsx` only controls the
// document-wide default) — see jobs/027-polish-misc.md's Handoff notes for
// why that's a deliberate scope call, not an oversight, and what a future
// job would need to add (a per-edge context-menu entry calling
// `updateEdge(sfmDoc, edgeId, { style })`, which `@scm/ydoc` already
// supports with zero further changes).
import type { ConnectionStyle } from "@scm/ydoc";

export type ConnectionStyleName = ConnectionStyle;

/**
 * Job 028: `labelKey` is the ORIGINAL tool's own string-table key
 * (`resources/languages/translations/*.json`'s `DIRECT`/`CURVES`/
 * `HORIZONTAL`/`VERTICAL`) — a clean reuse case, not a new key: PLAN.md's
 * own "Direct/Curves/Horizontal/Vertical" UI copy this module's header
 * comment already cites turns out to be verbatim what the original
 * string table calls these same four options, and `SettingsMenu.tsx`'s
 * labels were already using that exact English wording before this job.
 * Looked up in the default `translation` namespace (not `app`).
 */
export const CONNECTION_STYLE_OPTIONS: readonly { value: ConnectionStyleName; labelKey: string }[] = [
  { value: "straight", labelKey: "DIRECT" },
  { value: "bezier", labelKey: "CURVES" },
  { value: "step", labelKey: "HORIZONTAL" },
];

const KNOWN_STYLES: ReadonlySet<string> = new Set(["straight", "step", "bezier"]);

/** The precedence rule described above — a per-edge override wins when it's a recognized style, else the document-wide default. */
export function resolveConnectionStyle(
  edgeStyle: string | null | undefined,
  documentDefault: ConnectionStyleName,
): ConnectionStyleName {
  return edgeStyle && KNOWN_STYLES.has(edgeStyle) ? (edgeStyle as ConnectionStyleName) : documentDefault;
}

export interface Point {
  x: number;
  y: number;
}

export type PathCommand =
  | { type: "M"; point: Point }
  | { type: "L"; point: Point }
  | { type: "C"; c1: Point; c2: Point; point: Point }
  | { type: "Q"; c: Point; point: Point };

function straightPath(points: readonly Point[]): PathCommand[] {
  const [first, ...rest] = points as [Point, ...Point[]];
  return [{ type: "M", point: first }, ...rest.map((point) => ({ type: "L" as const, point }))];
}

/**
 * Every node type on this canvas (`RecipeNode`, `SplurgerNode`,
 * `OutpostNode`, `BlueprintNode`) wires its `<Handle>`s exclusively as
 * `Position.Left` (input) / `Position.Right` (output) — never top/bottom.
 * That means a curve leaving a source is ALWAYS leaving rightward, and a
 * curve arriving at a target is ALWAYS arriving from the left, regardless of
 * where the other end actually sits — a target above/below the source
 * should still see the line leave horizontally before it curves up or down
 * toward it. `horizontalControlOffset` is the magnitude of that
 * forced-horizontal control-point displacement, derived from React Flow's
 * own `getBezierPath` curvature formula (half the horizontal distance when
 * the other point is ahead, a slower sqrt falloff when it's behind — so a
 * target directly behind the source still loops outward instead of
 * collapsing) — with `MIN_CONTROL_OFFSET` on top so a near-vertical
 * connection (`dx` close to 0) still gets a visible horizontal run before it
 * curves, instead of leaving the node pointed almost straight up/down.
 */
const CURVATURE = 0.25;
const MIN_CONTROL_OFFSET = 30;

function horizontalControlOffset(dx: number): number {
  const magnitude = dx >= 0 ? dx / 2 : CURVATURE * 25 * Math.sqrt(-dx);
  return Math.max(magnitude, MIN_CONTROL_OFFSET);
}

/** The control point leaving `from` on its way toward `to` — always horizontal, per `horizontalControlOffset`'s header comment. */
function outgoingControlPoint(from: Point, to: Point): Point {
  return { x: from.x + horizontalControlOffset(to.x - from.x), y: from.y };
}

/** The control point arriving at `to` from `from`'s direction — always horizontal, mirrored around `to`. */
function incomingControlPoint(from: Point, to: Point): Point {
  return { x: to.x - horizontalControlOffset(to.x - from.x), y: to.y };
}

/**
 * The common case: a fresh connection with no waypoints at all (exactly
 * `[source, target]`). Catmull-Rom (below) has nothing to derive curvature
 * from here — with only two real points, both of its "phantom" neighbor
 * points collapse onto the source/target themselves, so all four control
 * points end up collinear and the curve renders as a dead-straight line
 * indistinguishable from "Direct" (the bug this fixes). Instead, bow the
 * curve out horizontally from both ends (see `horizontalControlOffset`).
 */
function twoPointBezier(a: Point, b: Point): PathCommand[] {
  return [{ type: "M", point: a }, { type: "C", c1: outgoingControlPoint(a, b), c2: incomingControlPoint(a, b), point: b }];
}

/**
 * Catmull-Rom-to-Bezier: a smooth cubic curve that passes exactly THROUGH
 * every point in `points` (never just near it) — critical for "remain
 * compatible with existing waypoints" (Job 011): a waypoint the user
 * dragged to a specific spot has to still visually sit ON the curve, not be
 * merely influential over its shape. Uniform parameterization, tension 1/6
 * (the standard uniform-Catmull-Rom-to-Bezier conversion).
 *
 * The first and last segments are the exception: `points[0]`/`points[n-1]`
 * are always the source/target NODE, never a waypoint, so (per
 * `horizontalControlOffset`'s header comment) their tangent is forced
 * horizontal instead of the plain Catmull-Rom formula — otherwise a
 * waypoint dragged only slightly off the source-target line barely bends
 * that formula's `(neighbor - node) / 6` tangent away from a straight line,
 * which is what made a freshly-dragged waypoint look like it had flattened
 * the curve near the node instead of smoothly bowing away from it. Interior
 * segments (waypoint-to-waypoint) are untouched — genuine Catmull-Rom,
 * clamped by duplicating the first/last point rather than extrapolating
 * past them so the curve doesn't overshoot outside the source/target bounds
 * at either end. The plain 2-point case is delegated to `twoPointBezier`
 * above, since there's no waypoint-to-waypoint segment to speak of there.
 */
function bezierPath(points: readonly Point[]): PathCommand[] {
  const n = points.length;
  if (n === 2) return twoPointBezier(points[0]!, points[1]!);
  const commands: PathCommand[] = [{ type: "M", point: points[0]! }];
  for (let i = 0; i < n - 1; i++) {
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    let c1: Point;
    if (i === 0) {
      c1 = outgoingControlPoint(p1, p2);
    } else {
      const p0 = points[i - 1]!;
      c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    }
    let c2: Point;
    if (i === n - 2) {
      c2 = incomingControlPoint(p1, p2);
    } else {
      const p3 = points[i + 2]!;
      c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    }
    commands.push({ type: "C", c1, c2, point: p2 });
  }
  return commands;
}

/**
 * One right-angle "hop" from `a` to `b` via two auto-inserted corners at the
 * midline of the horizontal axis (`(mid.x, a.y)` -> `(mid.x, b.y)`). `a`
 * itself is assumed already emitted by the caller (either the initial `M`,
 * or the previous hop's own terminal `L b`) — this function only appends
 * the two corners and the final `L point: b`, which is what guarantees every
 * REAL point in the original list (never just the synthetic corners) ends
 * up as some command's anchor.
 */
function appendOrthogonalHop(commands: PathCommand[], a: Point, b: Point): void {
  const midX = (a.x + b.x) / 2;
  commands.push({ type: "L", point: { x: midX, y: a.y } });
  commands.push({ type: "L", point: { x: midX, y: b.y } });
  commands.push({ type: "L", point: b });
}

function orthogonalPath(points: readonly Point[]): PathCommand[] {
  const commands: PathCommand[] = [{ type: "M", point: points[0]! }];
  for (let i = 0; i < points.length - 1; i++) {
    appendOrthogonalHop(commands, points[i]!, points[i + 1]!);
  }
  return commands;
}

/**
 * Builds the structured path-command list for `points` (`[source,
 * ...waypoints, target]`, same convention as `edgeGeometry.ts`'s
 * `buildPolyline`) under the given style. Degenerates gracefully for 0/1
 * points (no path / a bare `M`), mirroring `edgeGeometry.ts`'s own
 * degenerate handling.
 */
export function buildStyledPath(points: readonly Point[], style: ConnectionStyleName): PathCommand[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ type: "M", point: points[0]! }];

  switch (style) {
    case "straight":
      return straightPath(points);
    case "bezier":
      return bezierPath(points);
    case "step":
      return orthogonalPath(points);
  }
}

export function commandsToPathD(commands: readonly PathCommand[]): string {
  return commands
    .map((cmd) => {
      switch (cmd.type) {
        case "M":
          return `M ${cmd.point.x} ${cmd.point.y}`;
        case "L":
          return `L ${cmd.point.x} ${cmd.point.y}`;
        case "C":
          return `C ${cmd.c1.x} ${cmd.c1.y} ${cmd.c2.x} ${cmd.c2.y} ${cmd.point.x} ${cmd.point.y}`;
        case "Q":
          return `Q ${cmd.c.x} ${cmd.c.y} ${cmd.point.x} ${cmd.point.y}`;
      }
    })
    .join(" ");
}

/** `buildStyledPath` + `commandsToPathD` in one call — what `ConnectionEdge.tsx` actually calls per render. */
export function buildStyledPathD(points: readonly Point[], style: ConnectionStyleName): string {
  return commandsToPathD(buildStyledPath(points, style));
}
