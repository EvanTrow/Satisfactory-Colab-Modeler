# Job 011: Connections & waypoints

**Phase:** 2 · Solo canvas editor
**Status:** Not started
**Depends on:** 010 (recipe node UI — needs real ports to connect)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce** ("Connect" and "Waypoints" rows) closely — the gestures are specific and easy to get subtly wrong: drag output→input *or* input→output both work; remove by re-dragging or right-clicking the part label; double-left-click a connection label or waypoint adds a waypoint; double-right-click a waypoint deletes it; double-right-click a bare label deletes the connection; waypoints are draggable and stay put when their machine moves.

## Scope

In scope:
- Drag-to-connect between node ports using React Flow's edge-drawing interaction, supporting both drag directions (output→input and input→output resolve to the same logical edge).
- On successful connect, call `packages/ydoc`'s deterministic-`edgeId` edge-creation mutation from Job 007 — reuse it as-is, don't reimplement ID generation here.
- Edge removal: re-dragging an existing connection's endpoint elsewhere, or right-clicking the part label, removes the edge via `packages/ydoc`'s removal mutation.
- Waypoints:
  - Double-left-click a connection label or an existing waypoint adds a new waypoint at that position, stored in the edge's `waypoints: Y.Array<{x,y}>`.
  - Double-right-click a waypoint deletes just that waypoint.
  - Double-right-click a bare connection label (no waypoint under the cursor) deletes the whole connection.
  - Waypoints are draggable independently and do **not** move when either endpoint machine is dragged (i.e. they're stored as absolute canvas coordinates, not relative offsets — verify this explicitly, it's a common bug).
- Edge rendering must correctly route through however many waypoints exist, in order.
- Only compatible ports should be connectable (same `part` type on both ends) — reject/no-op a connect attempt between mismatched parts, since PLAN.md's data model assumes one part per edge.

Out of scope:
- Connection style options (Direct/Curves/Horizontal/Vertical) — explicitly a later-phase item in PLAN.md §3.
- Multi-select of edges, cut/copy/paste of connections — Job 012.
- Priority splitter/merger specific connection behavior — Phase 6 (Job 024).

## Deliverables

- Edge-drawing interaction wired into the canvas, both directions.
- Edge removal via re-drag and right-click-label.
- Waypoint add/delete via the exact double-click gestures above, with waypoints stored as absolute coordinates that survive endpoint drags.
- Part-type compatibility check preventing mismatched connections.
- Tests: deterministic edgeId reuse (connecting the same two ports twice doesn't duplicate — this exercises Job 007's guarantee end-to-end through the UI layer), waypoint persistence across an endpoint node drag.

## Acceptance criteria

- Both connect directions work and produce identical resulting edges.
- All four waypoint gestures behave exactly as specified in PLAN.md §2.
- Dragging a node with a connected, waypointed edge leaves the waypoint's absolute position unchanged.
- Attempting to connect two ports carrying different parts is rejected with no edge created.
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- Re-use `packages/ydoc`'s edge helpers from Job 007 rather than writing new Yjs mutation code in `apps/web`.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
