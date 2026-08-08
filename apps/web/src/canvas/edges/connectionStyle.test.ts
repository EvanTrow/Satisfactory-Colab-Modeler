import { describe, expect, it } from "vitest";

import {
  buildStyledPath,
  buildStyledPathD,
  CONNECTION_STYLE_OPTIONS,
  resolveConnectionStyle,
  type Point,
} from "./connectionStyle";

const SOURCE: Point = { x: 0, y: 0 };
const WAYPOINT_1: Point = { x: 50, y: 100 };
const WAYPOINT_2: Point = { x: 150, y: -40 };
const TARGET: Point = { x: 200, y: 60 };
const FOUR_POINTS = [SOURCE, WAYPOINT_1, WAYPOINT_2, TARGET];

describe("resolveConnectionStyle", () => {
  it("prefers a valid per-edge override over the document default", () => {
    expect(resolveConnectionStyle("bezier", "straight")).toBe("bezier");
    expect(resolveConnectionStyle("step", "bezier")).toBe("step");
  });

  it("falls back to the document default for null/undefined/unrecognized", () => {
    expect(resolveConnectionStyle(null, "bezier")).toBe("bezier");
    expect(resolveConnectionStyle(undefined, "step")).toBe("step");
    expect(resolveConnectionStyle("not-a-real-style", "straight")).toBe("straight");
    expect(resolveConnectionStyle("", "bezier")).toBe("bezier");
    // The removed "Vertical"/smoothstep style is no longer recognized —
    // an edge still carrying that legacy value falls back to the default.
    expect(resolveConnectionStyle("smoothstep", "straight")).toBe("straight");
  });
});

describe("CONNECTION_STYLE_OPTIONS", () => {
  it("maps all three PLAN.md-facing labels to the schema's three enum values, 1:1", () => {
    expect(CONNECTION_STYLE_OPTIONS).toHaveLength(3);
    const values = CONNECTION_STYLE_OPTIONS.map((o) => o.value);
    expect(new Set(values)).toEqual(new Set(["straight", "bezier", "step"]));
    const labelKeys = CONNECTION_STYLE_OPTIONS.map((o) => o.labelKey);
    expect(new Set(labelKeys)).toEqual(new Set(["DIRECT", "CURVES", "HORIZONTAL"]));
  });
});

describe("buildStyledPath / buildStyledPathD — degenerate inputs", () => {
  it("returns an empty path for zero points", () => {
    expect(buildStyledPath([], "straight")).toEqual([]);
    expect(buildStyledPathD([], "bezier")).toBe("");
  });

  it("returns a bare moveto for a single point, regardless of style", () => {
    for (const style of ["straight", "bezier", "step"] as const) {
      expect(buildStyledPath([SOURCE], style)).toEqual([{ type: "M", point: SOURCE }]);
    }
  });
});

/**
 * The core "remains compatible with existing waypoints" invariant (Job 011):
 * every ORIGINAL point (source, every waypoint, target — never a synthetic
 * routing corner) must appear, in order, as some command's own anchor
 * (`.point`), for every one of the three styles. This is what "correctly
 * routes through existing waypoints" concretely means and is checkable.
 */
function anchors(style: "straight" | "bezier" | "step"): Point[] {
  return buildStyledPath(FOUR_POINTS, style).map((cmd) => cmd.point);
}

describe("every style routes through every original point, in order", () => {
  it.each(["straight", "bezier", "step"] as const)("%s", (style) => {
    const points = anchors(style);
    // Each of FOUR_POINTS must appear, and in the same relative order —
    // i.e. FOUR_POINTS is a subsequence of the command anchors.
    let cursor = 0;
    for (const expected of FOUR_POINTS) {
      const foundAt = points.findIndex(
        (p, i) => i >= cursor && p.x === expected.x && p.y === expected.y,
      );
      expect(foundAt).toBeGreaterThanOrEqual(cursor);
      cursor = foundAt + 1;
    }
  });
});

describe("straight", () => {
  it("is a plain M/L polyline through every point, nothing synthetic", () => {
    const commands = buildStyledPath(FOUR_POINTS, "straight");
    expect(commands).toEqual([
      { type: "M", point: SOURCE },
      { type: "L", point: WAYPOINT_1 },
      { type: "L", point: WAYPOINT_2 },
      { type: "L", point: TARGET },
    ]);
  });
});

describe("bezier", () => {
  it("uses only M/C commands (a genuine curve, not disguised straight lines)", () => {
    const commands = buildStyledPath(FOUR_POINTS, "bezier");
    expect(commands[0]!.type).toBe("M");
    expect(commands.slice(1).every((c) => c.type === "C")).toBe(true);
    expect(commands).toHaveLength(FOUR_POINTS.length); // M + one C per segment
  });

  it("produces a different path than straight for a genuinely bent polyline", () => {
    expect(buildStyledPathD(FOUR_POINTS, "bezier")).not.toBe(buildStyledPathD(FOUR_POINTS, "straight"));
  });

  /**
   * Regression test for the reported "Curves looks identical to Direct"
   * bug: a fresh connection with no waypoints (exactly two points) used to
   * degenerate to collinear control points (Catmull-Rom has nothing to
   * derive curvature from with only two real points), rendering the same
   * as a straight line despite emitting a `C` command. `twoPointBezier`
   * fixes this by bowing the curve into an S-shape instead.
   */
  it("bows into a genuine curve for the plain 2-point (no-waypoint) case", () => {
    const a: Point = { x: 0, y: 0 };
    const b: Point = { x: 200, y: 60 };
    const commands = buildStyledPath([a, b], "bezier");
    expect(commands).toEqual([
      { type: "M", point: a },
      {
        type: "C",
        c1: { x: 100, y: 0 },
        c2: { x: 100, y: 60 },
        point: b,
      },
    ]);
    // The control points must NOT be collinear with a/b — that's exactly
    // what made this render identically to "straight".
    const { c1, c2 } = commands[1] as { c1: Point; c2: Point };
    expect(c1.y).not.toBe(c2.y);
    expect(buildStyledPathD([a, b], "bezier")).not.toBe(buildStyledPathD([a, b], "straight"));
  });

  /**
   * Every node's handles are `Position.Left`/`Position.Right` only (see
   * `connectionStyle.ts`'s `horizontalControlOffset` header comment) — so a
   * curve must always leave the source and arrive at the target moving
   * horizontally, even when the connection is far taller than it is wide.
   * Previously this bowed around the *vertical* axis instead (control
   * points sharing the endpoints' own x), which made a near-vertical
   * connection point almost straight up/down out of the node instead of
   * curving away sideways first.
   */
  it("still leaves/arrives horizontally when the segment is taller than it is wide", () => {
    const a: Point = { x: 0, y: 0 };
    const b: Point = { x: 40, y: 300 };
    const commands = buildStyledPath([a, b], "bezier");
    const { c1, c2 } = commands[1] as { c1: Point; c2: Point };
    expect(c1.y).toBe(a.y);
    expect(c2.y).toBe(b.y);
    expect(c1.x).toBeGreaterThan(a.x);
    expect(c2.x).toBeLessThan(b.x);
  });

  it("keeps a visible horizontal run even when the two points are directly stacked (dx = 0)", () => {
    const a: Point = { x: 100, y: 0 };
    const b: Point = { x: 100, y: 300 };
    const commands = buildStyledPath([a, b], "bezier");
    const { c1, c2 } = commands[1] as { c1: Point; c2: Point };
    expect(c1).toEqual({ x: a.x + 30, y: a.y });
    expect(c2).toEqual({ x: b.x - 30, y: b.y });
  });

  /**
   * Regression test for "dragging the label a small amount looks more
   * straight": adding a single waypoint just barely off the source-target
   * line must not flatten the tangent leaving the source — it should still
   * bow out horizontally, same as the plain 2-point case, because
   * `points[0]` is the source NODE either way.
   */
  it("still leaves the source horizontally once a waypoint exists nearby", () => {
    const source: Point = { x: 0, y: 0 };
    const waypoint: Point = { x: 100, y: 2 }; // barely off the straight line to target
    const target: Point = { x: 200, y: 0 };
    const commands = buildStyledPath([source, waypoint, target], "bezier");
    const first = commands[1] as { c1: Point; c2: Point };
    expect(first.c1.y).toBe(source.y);
    expect(first.c1.x).toBeGreaterThan(source.x + 10);
    const last = commands[2] as { c1: Point; c2: Point };
    expect(last.c2.y).toBe(target.y);
    expect(last.c2.x).toBeLessThan(target.x - 10);
  });
});

describe("step (Horizontal)", () => {
  it("uses only M/L commands (sharp right-angle corners, no curves)", () => {
    const commands = buildStyledPath(FOUR_POINTS, "step");
    expect(commands.every((c) => c.type === "M" || c.type === "L")).toBe(true);
  });

  it("inserts two extra corner points per segment (more L commands than straight)", () => {
    const straightCommands = buildStyledPath(FOUR_POINTS, "straight");
    const stepCommands = buildStyledPath(FOUR_POINTS, "step");
    expect(stepCommands.length).toBeGreaterThan(straightCommands.length);
  });

  it("bends around a vertical midline — each segment's first corner shares the source's own y", () => {
    const a = SOURCE;
    const b = WAYPOINT_1;
    const commands = buildStyledPath([a, b], "step");
    // M a, L corner1, L corner2, L b
    expect(commands[1]).toMatchObject({ type: "L", point: { x: (a.x + b.x) / 2, y: a.y } });
    expect(commands[2]).toMatchObject({ type: "L", point: { x: (a.x + b.x) / 2, y: b.y } });
  });
});

describe("all three styles render distinctly for the same input", () => {
  it("produces three different path strings", () => {
    const paths = (["straight", "bezier", "step"] as const).map((style) =>
      buildStyledPathD(FOUR_POINTS, style),
    );
    expect(new Set(paths).size).toBe(3);
  });
});
