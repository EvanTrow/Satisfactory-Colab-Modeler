import { describe, expect, it } from "vitest";

import {
  colorFromUserId,
  createLocalAwarenessState,
  isCursorVisibleInContainer,
  isDraggingVisibleInContainer,
  isEdgeDraggingVisibleInContainer,
  parseAwarenessState,
  selectVisibleCursors,
  type AwarenessState,
} from "./awareness";

describe("colorFromUserId", () => {
  it("is deterministic — the same userId always produces the same color", () => {
    const a = colorFromUserId("user-123");
    const b = colorFromUserId("user-123");
    expect(a).toBe(b);
  });

  it("is stable across repeated calls in a fresh process-like sequence (no hidden mutable state)", () => {
    const colors = Array.from({ length: 5 }, () => colorFromUserId("stable-user"));
    expect(new Set(colors).size).toBe(1);
  });

  it("produces a well-formed hsl() string", () => {
    expect(colorFromUserId("anyone")).toMatch(/^hsl\(\d{1,3}, 70%, 55%\)$/);
  });

  it("differs for different userIds (not a guarantee in general, but true for these fixtures — catches a trivially-constant implementation)", () => {
    const colors = new Set([
      colorFromUserId("alice"),
      colorFromUserId("bob"),
      colorFromUserId("carol"),
      colorFromUserId("dave"),
    ]);
    expect(colors.size).toBeGreaterThan(1);
  });

  it("keeps the hue within [0, 360)", () => {
    for (const id of ["", "a", "a very long user id string with lots of characters in it"]) {
      const match = /^hsl\((\d+),/.exec(colorFromUserId(id));
      expect(match).not.toBeNull();
      const hue = Number(match![1]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("createLocalAwarenessState", () => {
  it("starts with an empty presence footprint (no cursor, no selection, not editing anything)", () => {
    const state = createLocalAwarenessState({ id: "u1", displayName: "Alice", avatarUrl: "https://example.com/a.png" });
    expect(state).toEqual<AwarenessState>({
      userId: "u1",
      displayName: "Alice",
      avatarUrl: "https://example.com/a.png",
      color: colorFromUserId("u1"),
      cursor: null,
      selection: [],
      editingField: null,
      dragging: null,
      edgeDragging: null,
    });
  });
});

describe("parseAwarenessState", () => {
  const valid: AwarenessState = {
    userId: "u1",
    displayName: "Alice",
    avatarUrl: "https://example.com/a.png",
    color: "hsl(120, 70%, 55%)",
    cursor: { x: 10, y: 20, containerId: "root" },
    selection: ["n1", "n2"],
    editingField: { nodeId: "n1", field: "limit" },
    dragging: { containerId: "root", nodes: [{ id: "n1", x: 30, y: 40 }], waypoints: [{ edgeId: "e1", index: 0, x: 5, y: 6 }] },
    edgeDragging: { containerId: "root", edgeId: "e1", mode: "move", waypointIndex: 0, x: 50, y: 60 },
  };

  it("accepts a fully well-formed state, including a non-null cursor/editingField/dragging/edgeDragging", () => {
    expect(parseAwarenessState(valid)).toEqual(valid);
  });

  it("accepts a well-formed state with null cursor/editingField/dragging/edgeDragging and empty selection", () => {
    const minimal: AwarenessState = {
      ...valid,
      cursor: null,
      selection: [],
      editingField: null,
      dragging: null,
      edgeDragging: null,
    };
    expect(parseAwarenessState(minimal)).toEqual(minimal);
  });

  it("rejects a state with a malformed dragging (bad containerId, non-array nodes, or a malformed node)", () => {
    expect(parseAwarenessState({ ...valid, dragging: { nodes: [] } })).toBeNull();
    expect(parseAwarenessState({ ...valid, dragging: { containerId: "root", nodes: "not an array" } })).toBeNull();
    expect(
      parseAwarenessState({ ...valid, dragging: { containerId: "root", nodes: [{ id: "n1", x: "nope", y: 0 }] } }),
    ).toBeNull();
  });

  it("accepts a dragging payload with no `waypoints` field at all (a peer running an older client build) as an empty list — not a rejection", () => {
    const result = parseAwarenessState({
      ...valid,
      dragging: { containerId: "root", nodes: [{ id: "n1", x: 30, y: 40 }] },
    });
    expect(result?.dragging).toEqual({ containerId: "root", nodes: [{ id: "n1", x: 30, y: 40 }], waypoints: [] });
  });

  it("rejects a dragging payload with a malformed waypoints entry (non-array, or missing/wrong-typed fields)", () => {
    expect(
      parseAwarenessState({
        ...valid,
        dragging: { containerId: "root", nodes: [], waypoints: "not an array" },
      }),
    ).toBeNull();
    expect(
      parseAwarenessState({
        ...valid,
        dragging: { containerId: "root", nodes: [], waypoints: [{ edgeId: "e1", index: "nope", x: 0, y: 0 }] },
      }),
    ).toBeNull();
  });

  it("rejects a state with a malformed edgeDragging (missing fields, bad mode, or wrong types)", () => {
    expect(parseAwarenessState({ ...valid, edgeDragging: { containerId: "root", edgeId: "e1" } })).toBeNull();
    expect(
      parseAwarenessState({
        ...valid,
        edgeDragging: { containerId: "root", edgeId: "e1", mode: "bogus", waypointIndex: 0, x: 1, y: 2 },
      }),
    ).toBeNull();
    expect(
      parseAwarenessState({
        ...valid,
        edgeDragging: { containerId: "root", edgeId: "e1", mode: "move", waypointIndex: "nope", x: 1, y: 2 },
      }),
    ).toBeNull();
  });

  it.each([null, undefined, "a string", 42, []])("rejects a non-object root value (%p)", (raw) => {
    expect(parseAwarenessState(raw)).toBeNull();
  });

  it("rejects a state missing userId", () => {
    const withoutUserId: Record<string, unknown> = { ...valid };
    delete withoutUserId.userId;
    expect(parseAwarenessState(withoutUserId)).toBeNull();
  });

  it("rejects a state with an empty-string userId", () => {
    expect(parseAwarenessState({ ...valid, userId: "" })).toBeNull();
  });

  it("rejects a state with a malformed cursor", () => {
    expect(parseAwarenessState({ ...valid, cursor: { x: "not a number", y: 1, containerId: "root" } })).toBeNull();
    expect(parseAwarenessState({ ...valid, cursor: "not an object" })).toBeNull();
  });

  it("rejects a state with a malformed editingField", () => {
    expect(parseAwarenessState({ ...valid, editingField: { nodeId: "n1" } })).toBeNull();
  });

  it("rejects a state whose selection isn't an array of strings", () => {
    expect(parseAwarenessState({ ...valid, selection: "not an array" })).toBeNull();
    expect(parseAwarenessState({ ...valid, selection: [1, 2, 3] })).toBeNull();
  });
});

describe("isCursorVisibleInContainer / selectVisibleCursors (container-scoped cursor rendering)", () => {
  it("a null cursor is never visible, regardless of the viewed container", () => {
    expect(isCursorVisibleInContainer(null, "root")).toBe(false);
  });

  it("a cursor in the SAME container as the viewer is visible", () => {
    expect(isCursorVisibleInContainer({ x: 1, y: 2, containerId: "outpost-a" }, "outpost-a")).toBe(true);
  });

  it("a cursor in a DIFFERENT container than the viewer is invisible — the core container-scoping requirement", () => {
    expect(isCursorVisibleInContainer({ x: 1, y: 2, containerId: "outpost-a" }, "outpost-b")).toBe(false);
    expect(isCursorVisibleInContainer({ x: 1, y: 2, containerId: "root" }, "outpost-a")).toBe(false);
  });

  it("selectVisibleCursors filters a mixed list down to only same-container, non-null cursors", () => {
    const base: AwarenessState = {
      userId: "u",
      displayName: "u",
      avatarUrl: "",
      color: "hsl(0, 70%, 55%)",
      selection: [],
      editingField: null,
      dragging: null,
      edgeDragging: null,
      cursor: null,
    };
    const inRoot: AwarenessState = { ...base, userId: "in-root", cursor: { x: 0, y: 0, containerId: "root" } };
    const inOtherOutpost: AwarenessState = {
      ...base,
      userId: "in-outpost",
      cursor: { x: 0, y: 0, containerId: "outpost-a" },
    };
    const noCursor: AwarenessState = { ...base, userId: "no-cursor", cursor: null };

    const visible = selectVisibleCursors([inRoot, inOtherOutpost, noCursor], "root");
    expect(visible).toEqual([inRoot]);
  });
});

describe("isDraggingVisibleInContainer (live drag broadcast, container-scoped)", () => {
  it("null dragging is never visible, regardless of the viewed container", () => {
    expect(isDraggingVisibleInContainer(null, "root")).toBe(false);
  });

  it("a drag in the SAME container as the viewer is visible", () => {
    expect(
      isDraggingVisibleInContainer(
        { containerId: "outpost-a", nodes: [{ id: "n1", x: 0, y: 0 }], waypoints: [] },
        "outpost-a",
      ),
    ).toBe(true);
  });

  it("a drag in a DIFFERENT container than the viewer is invisible", () => {
    expect(
      isDraggingVisibleInContainer(
        { containerId: "outpost-a", nodes: [{ id: "n1", x: 0, y: 0 }], waypoints: [] },
        "root",
      ),
    ).toBe(false);
  });
});

describe("isEdgeDraggingVisibleInContainer (live waypoint/label drag broadcast, container-scoped)", () => {
  it("null edgeDragging is never visible, regardless of the viewed container", () => {
    expect(isEdgeDraggingVisibleInContainer(null, "root")).toBe(false);
  });

  it("an edge drag in the SAME container as the viewer is visible", () => {
    expect(
      isEdgeDraggingVisibleInContainer(
        { containerId: "outpost-a", edgeId: "e1", mode: "move", waypointIndex: 0, x: 0, y: 0 },
        "outpost-a",
      ),
    ).toBe(true);
  });

  it("an edge drag in a DIFFERENT container than the viewer is invisible", () => {
    expect(
      isEdgeDraggingVisibleInContainer(
        { containerId: "outpost-a", edgeId: "e1", mode: "insert", waypointIndex: 0, x: 0, y: 0 },
        "root",
      ),
    ).toBe(false);
  });
});
