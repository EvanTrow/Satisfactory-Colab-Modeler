// Job 027: connection style rendering — PLAN.md §3's "connection style
// options (Direct/Curves/Horizontal/Vertical)", wired to `@scm/ydoc`'s
// already-existing `Settings.connectionStyle`/`EdgeRecord.style` (Job 007's
// schema, unused by any rendering code until this job — see Job 014's own
// Handoff notes flagging both fields explicitly as this job's territory).
// Pure geometry, kept separate from `edgeGeometry.ts` (Job 011's straight-
// polyline math, which this module reuses conceptually but not by import —
// see below) so it's independently unit-testable without any DOM/React Flow
// setup, following every prior canvas job's pattern.
//
// ---------------------------------------------------------------------------
// Naming reconciliation — PLAN.md's UI copy vs. `@scm/ydoc`'s schema enum
// ---------------------------------------------------------------------------
// PLAN.md's own wording names four *user-facing* options — Direct / Curves /
// Horizontal / Vertical — but `ConnectionStyleSchema`
// (`packages/ydoc/src/schema.ts`) types the field as React-Flow-native
// names: `"straight" | "step" | "smoothstep" | "bezier"`. Job 007 picked
// those names to match `@xyflow/react`'s own edge-type vocabulary (a
// sensible schema choice on its own), but never reconciled them against
// PLAN.md's later "Later phases" UI wording — this job is the first to need
// both at once, so here's the mapping this file (and `SettingsMenu.tsx`,
// which shows the PLAN.md-facing labels) commits to:
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
//   Vertical   -> "smoothstep"  the same orthogonal routing shape, but
//                                VERTICAL first/last legs, with corners
//                                rounded (a small quadratic-Bezier cut) —
//                                this is also what gives "smoothstep" a
//                                visibly distinct look from "step" beyond
//                                just the axis, matching its name.
//
// "step" vs. "smoothstep" in `@xyflow/react`'s own built-in edge types
// differ ONLY by corner rounding, not by axis — this app's reinterpretation
// (axis AND rounding both differ) is a deliberate, documented choice to get
// four *visually and semantically distinct* options out of the schema's
// four-name enum, rather than two pairs that only differ in one subtle
// dimension. If a future job wants literal `@xyflow/react`-identical step/
// smoothstep behavior instead, this is the one file to change — nothing
// downstream (`ConnectionEdge.tsx`, `SettingsMenu.tsx`) depends on the
// specific shape, only on `buildStyledPathD` producing *some* valid path
// through every point.
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
  { value: "smoothstep", labelKey: "VERTICAL" },
];

const KNOWN_STYLES: ReadonlySet<string> = new Set(["straight", "step", "smoothstep", "bezier"]);

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

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Point `dist` of the way from `from` toward `towards` (clamped so it never overshoots `towards`). */
function pullBack(from: Point, towards: Point, dist: number): Point {
  const total = distance(from, towards);
  if (total === 0) return { x: from.x, y: from.y };
  const t = Math.min(1, dist / total);
  return { x: from.x + (towards.x - from.x) * t, y: from.y + (towards.y - from.y) * t };
}

function straightPath(points: readonly Point[]): PathCommand[] {
  const [first, ...rest] = points as [Point, ...Point[]];
  return [{ type: "M", point: first }, ...rest.map((point) => ({ type: "L" as const, point }))];
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
 * bounds at either end.
 */
function bezierPath(points: readonly Point[]): PathCommand[] {
  const commands: PathCommand[] = [{ type: "M", point: points[0]! }];
  const n = points.length;
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
 * midline of whichever axis is NOT the dominant direction (`axis`
 * `"horizontal"` bends around a vertical midline at `(mid.x, a.y)` ->
 * `(mid.x, b.y)`; `"vertical"` bends around a horizontal midline). `a`
 * itself is assumed already emitted by the caller (either the initial `M`,
 * or the previous hop's own terminal `L b`) — this function only appends
 * the corner(s) and the final `L point: b`, which is what guarantees every
 * REAL point in the original list (never just the synthetic corners) ends
 * up as some command's anchor, for every one of the four styles.
 */
function appendOrthogonalHop(
  commands: PathCommand[],
  a: Point,
  b: Point,
  axis: "horizontal" | "vertical",
  rounded: boolean,
): void {
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const corner1: Point = axis === "horizontal" ? { x: midX, y: a.y } : { x: a.x, y: midY };
  const corner2: Point = axis === "horizontal" ? { x: midX, y: b.y } : { x: b.x, y: midY };

  if (!rounded) {
    commands.push({ type: "L", point: corner1 });
    commands.push({ type: "L", point: corner2 });
    commands.push({ type: "L", point: b });
    return;
  }

  // A small rounded-corner cut at each of the two bends: pull back `radius`
  // px along each adjacent segment and replace the sharp corner with a
  // quadratic curve through it. `radius` is capped by HALF of every
  // adjacent segment's own length so a short hop (e.g. two nearly-touching
  // points) never produces overlapping/backwards control geometry.
  const radius = Math.min(8, distance(a, corner1) / 2, distance(corner1, corner2) / 2, distance(corner2, b) / 2);
  const preCorner1 = pullBack(corner1, a, radius);
  const postCorner1 = pullBack(corner1, corner2, radius);
  const preCorner2 = pullBack(corner2, corner1, radius);
  const postCorner2 = pullBack(corner2, b, radius);

  commands.push({ type: "L", point: preCorner1 });
  commands.push({ type: "Q", c: corner1, point: postCorner1 });
  commands.push({ type: "L", point: preCorner2 });
  commands.push({ type: "Q", c: corner2, point: postCorner2 });
  commands.push({ type: "L", point: b });
}

function orthogonalPath(points: readonly Point[], axis: "horizontal" | "vertical", rounded: boolean): PathCommand[] {
  const commands: PathCommand[] = [{ type: "M", point: points[0]! }];
  for (let i = 0; i < points.length - 1; i++) {
    appendOrthogonalHop(commands, points[i]!, points[i + 1]!, axis, rounded);
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
      return orthogonalPath(points, "horizontal", false);
    case "smoothstep":
      return orthogonalPath(points, "vertical", true);
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
