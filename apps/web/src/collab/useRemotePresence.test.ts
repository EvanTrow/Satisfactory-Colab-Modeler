import { describe, expect, it } from "vitest";

import { derivePresenceWithFreshness, type TrackedDragEntry } from "./useRemotePresence";
import type { AwarenessState } from "./awareness";

function rawState(overrides: Partial<AwarenessState> = {}): AwarenessState {
  return {
    userId: "peer-1",
    displayName: "Peer",
    avatarUrl: "",
    color: "hsl(0, 70%, 55%)",
    cursor: null,
    selection: [],
    editingField: null,
    dragging: null,
    edgeDragging: null,
    ...overrides,
  };
}

const SELF_CLIENT_ID = 999;

describe("derivePresenceWithFreshness", () => {
  it("excludes the caller's own clientId", () => {
    const states = new Map<number, unknown>([[SELF_CLIENT_ID, rawState()]]);
    const result = derivePresenceWithFreshness(states, SELF_CLIENT_ID, new Map(), 0);
    expect(result).toEqual([]);
  });

  it("passes through a peer with no dragging/edgeDragging in flight, untouched", () => {
    const states = new Map<number, unknown>([[1, rawState()]]);
    const result = derivePresenceWithFreshness(states, SELF_CLIENT_ID, new Map(), 0);
    expect(result).toEqual([{ clientId: 1, state: rawState() }]);
  });

  it("keeps a freshly-observed dragging payload (first sample, not stale)", () => {
    const dragging = { containerId: "root", nodes: [{ id: "n1", x: 10, y: 20 }], waypoints: [] };
    const states = new Map<number, unknown>([[1, rawState({ dragging })]]);
    const tracked = new Map<number, TrackedDragEntry>();
    const result = derivePresenceWithFreshness(states, SELF_CLIENT_ID, tracked, 0);
    expect(result[0]?.state.dragging).toEqual(dragging);
  });

  it("keeps a dragging payload that keeps changing sample to sample (an in-progress drag)", () => {
    const tracked = new Map<number, TrackedDragEntry>();
    const posAt = (t: number) => ({
      containerId: "root",
      nodes: [{ id: "n1", x: t, y: 0 }],
      waypoints: [],
    });

    // Samples arrive every 50ms (the publisher's real cadence), well under
    // the 500ms staleness threshold between any two of them.
    let result = derivePresenceWithFreshness(
      new Map([[1, rawState({ dragging: posAt(0) })]]),
      SELF_CLIENT_ID,
      tracked,
      0,
    );
    expect(result[0]?.state.dragging).toEqual(posAt(0));

    result = derivePresenceWithFreshness(
      new Map([[1, rawState({ dragging: posAt(10) })]]),
      SELF_CLIENT_ID,
      tracked,
      450,
    );
    expect(result[0]?.state.dragging).toEqual(posAt(10));

    result = derivePresenceWithFreshness(
      new Map([[1, rawState({ dragging: posAt(20) })]]),
      SELF_CLIENT_ID,
      tracked,
      900,
    );
    expect(result[0]?.state.dragging).toEqual(posAt(20));
  });

  it("nulls out a dragging payload that stops updating for longer than the staleness threshold — the lost-clear() bug", () => {
    const dragging = { containerId: "root", nodes: [{ id: "n1", x: 10, y: 20 }], waypoints: [] };
    const tracked = new Map<number, TrackedDragEntry>();

    // t=0: the drag's last-ever sample arrives (its `clear()` broadcast is
    // the one that gets lost — this Awareness field never updates again).
    let result = derivePresenceWithFreshness(new Map([[1, rawState({ dragging })]]), SELF_CLIENT_ID, tracked, 0);
    expect(result[0]?.state.dragging).toEqual(dragging);

    // t=499ms: still within the threshold — still trusted.
    result = derivePresenceWithFreshness(new Map([[1, rawState({ dragging })]]), SELF_CLIENT_ID, tracked, 499);
    expect(result[0]?.state.dragging).toEqual(dragging);

    // t=501ms: past the threshold with no fresh sample in between — this is
    // exactly the bug this test guards against: without staleness tracking,
    // this stale position would override the node's real one forever.
    result = derivePresenceWithFreshness(new Map([[1, rawState({ dragging })]]), SELF_CLIENT_ID, tracked, 501);
    expect(result[0]?.state.dragging).toBeNull();
  });

  it("tracks dragging and edgeDragging staleness independently", () => {
    const dragging = { containerId: "root", nodes: [{ id: "n1", x: 1, y: 2 }], waypoints: [] };
    const edgeDragging = { containerId: "root", edgeId: "e1", mode: "move" as const, waypointIndex: 0, x: 3, y: 4 };
    const tracked = new Map<number, TrackedDragEntry>();

    derivePresenceWithFreshness(new Map([[1, rawState({ dragging, edgeDragging })]]), SELF_CLIENT_ID, tracked, 0);
    // Only `edgeDragging` keeps refreshing — `dragging`'s `clear()` was lost.
    derivePresenceWithFreshness(
      new Map([[1, rawState({ dragging, edgeDragging: { ...edgeDragging, x: 5 } })]]),
      SELF_CLIENT_ID,
      tracked,
      400,
    );
    const result = derivePresenceWithFreshness(
      new Map([[1, rawState({ dragging, edgeDragging: { ...edgeDragging, x: 5 } })]]),
      SELF_CLIENT_ID,
      tracked,
      900,
    );

    expect(result[0]?.state.dragging).toBeNull(); // stale — unchanged since t=0, now 900ms later.
    expect(result[0]?.state.edgeDragging).toEqual({ ...edgeDragging, x: 5 }); // fresh — last changed at t=400.
  });

  it("drops tracking for a clientId that disappears (peer disconnected) rather than leaking forever", () => {
    const dragging = { containerId: "root", nodes: [{ id: "n1", x: 1, y: 2 }], waypoints: [] };
    const tracked = new Map<number, TrackedDragEntry>();

    derivePresenceWithFreshness(new Map([[1, rawState({ dragging })]]), SELF_CLIENT_ID, tracked, 0);
    expect(tracked.has(1)).toBe(true);

    derivePresenceWithFreshness(new Map(), SELF_CLIENT_ID, tracked, 100);
    expect(tracked.has(1)).toBe(false);
  });

  it("ignores an entry whose raw state fails validation, same as parseAwarenessState itself", () => {
    const states = new Map<number, unknown>([[1, { not: "a valid awareness state" }]]);
    const result = derivePresenceWithFreshness(states, SELF_CLIENT_ID, new Map(), 0);
    expect(result).toEqual([]);
  });
});
