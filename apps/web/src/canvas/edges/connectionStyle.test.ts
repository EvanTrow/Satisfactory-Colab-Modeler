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
    expect(resolveConnectionStyle("step", "smoothstep")).toBe("step");
  });

  it("falls back to the document default for null/undefined/unrecognized", () => {
    expect(resolveConnectionStyle(null, "bezier")).toBe("bezier");
    expect(resolveConnectionStyle(undefined, "step")).toBe("step");
    expect(resolveConnectionStyle("not-a-real-style", "straight")).toBe("straight");
    expect(resolveConnectionStyle("", "smoothstep")).toBe("smoothstep");
  });
});

describe("CONNECTION_STYLE_OPTIONS", () => {
  it("maps all four PLAN.md-facing labels to the schema's four enum values, 1:1", () => {
    expect(CONNECTION_STYLE_OPTIONS).toHaveLength(4);
    const values = CONNECTION_STYLE_OPTIONS.map((o) => o.value);
    expect(new Set(values)).toEqual(new Set(["straight", "bezier", "step", "smoothstep"]));
    const labels = CONNECTION_STYLE_OPTIONS.map((o) => o.label);
    expect(new Set(labels)).toEqual(new Set(["Direct", "Curves", "Horizontal", "Vertical"]));
  });
});

describe("buildStyledPath / buildStyledPathD — degenerate inputs", () => {
  it("returns an empty path for zero points", () => {
    expect(buildStyledPath([], "straight")).toEqual([]);
    expect(buildStyledPathD([], "bezier")).toBe("");
  });

  it("returns a bare moveto for a single point, regardless of style", () => {
    for (const style of ["straight", "bezier", "step", "smoothstep"] as const) {
      expect(buildStyledPath([SOURCE], style)).toEqual([{ type: "M", point: SOURCE }]);
    }
  });
});

/**
 * The core "remains compatible with existing waypoints" invariant (Job 011):
 * every ORIGINAL point (source, every waypoint, target — never a synthetic
 * routing corner) must appear, in order, as some command's own anchor
 * (`.point`), for every one of the four styles. This is what "correctly
 * routes through existing waypoints" concretely means and is checkable.
 */
function anchors(style: "straight" | "bezier" | "step" | "smoothstep"): Point[] {
  return buildStyledPath(FOUR_POINTS, style).map((cmd) => cmd.point);
}

describe("every style routes through every original point, in order", () => {
  it.each(["straight", "bezier", "step", "smoothstep"] as const)("%s", (style) => {
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

describe("smoothstep (Vertical)", () => {
  it("bends around a horizontal midline — distinct axis from step", () => {
    const a = SOURCE;
    const b = WAYPOINT_1;
    // Radius may pull the corner's neighbors in, but the corner ITSELF
    // (the `Q` control point) is still the sharp bend at the horizontal
    // midline, unlike step's vertical-midline bend.
    const commands = buildStyledPath([a, b], "smoothstep");
    const qCommands = commands.filter((c) => c.type === "Q");
    expect(qCommands).toHaveLength(2);
    expect(qCommands[0]).toMatchObject({ c: { x: a.x, y: (a.y + b.y) / 2 } });
    expect(qCommands[1]).toMatchObject({ c: { x: b.x, y: (a.y + b.y) / 2 } });
  });

  it("uses Q (rounded corners) unlike step's sharp L-only corners", () => {
    const commands = buildStyledPath(FOUR_POINTS, "smoothstep");
    expect(commands.some((c) => c.type === "Q")).toBe(true);
  });

  it("renders a visibly different path string than step for the same points", () => {
    expect(buildStyledPathD(FOUR_POINTS, "smoothstep")).not.toBe(buildStyledPathD(FOUR_POINTS, "step"));
  });
});

describe("all four styles render distinctly for the same input", () => {
  it("produces four different path strings", () => {
    const paths = (["straight", "bezier", "step", "smoothstep"] as const).map((style) =>
      buildStyledPathD(FOUR_POINTS, style),
    );
    expect(new Set(paths).size).toBe(4);
  });
});
