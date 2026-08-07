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
 * The common case: a fresh connection with no waypoints at all (exactly
 * `[source, target]`). Catmull-Rom (below) has nothing to derive curvature
 * from here — with only two real points, both of its "phantom" neighbor
 * points collapse onto the source/target themselves, so all four control
 * points end up collinear and the curve renders as a dead-straight line
 * indistinguishable from "Direct" (the bug this fixes). Instead, bow the
 * curve into the standard flowchart "S" shape: pull each control point to
 * the midpoint of whichever axis dominates the segment, leaving the other
 * axis untouched at its own endpoint.
 */
function twoPointBezier(a: Point, b: Point): PathCommand[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const horizontalDominant = Math.abs(dx) >= Math.abs(dy);
  const c1: Point = horizontalDominant ? { x: a.x + dx / 2, y: a.y } : { x: a.x, y: a.y + dy / 2 };
  const c2: Point = horizontalDominant ? { x: b.x - dx / 2, y: b.y } : { x: b.x, y: b.y - dy / 2 };
  return [{ type: "M", point: a }, { type: "C", c1, c2, point: b }];
}

/**
 * Catmull-Rom-to-Bezier: a smooth cubic curve that passes exactly THROUGH
 * every point in `points` (never just near it) — critical for "remain
 * compatible with existing waypoints" (Job 011): a waypoint the user
 * dragged to a specific spot has to still visually sit ON the curve, not be
 * merely influential over its shape. Uniform parameterization, tension 1/6
 * (the standard uniform-Catmull-Rom-to-Bezier conversion) — endpoints are
 * clamped by duplicating the first/last point rather than extrapolating
 * past them, so the curve doesn't overshoot outside the source/target
 * bounds at either end. The plain 2-point case is delegated to
 * `twoPointBezier` above, since this duplication degenerates fully (both
 * ends at once) when there are no waypoints to anchor curvature to.
 */
function bezierPath(points: readonly Point[]): PathCommand[] {
  const n = points.length;
  if (n === 2) return twoPointBezier(points[0]!, points[1]!);
  const commands: PathCommand[] = [{ type: "M", point: points[0]! }];
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(n - 1, i + 2)]!;
    const c1: Point = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2: Point = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
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
