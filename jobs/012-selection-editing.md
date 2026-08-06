# Job 012: Selection, clipboard & undo/redo

**Phase:** 2 · Solo canvas editor
**Status:** Not started
**Depends on:** 011 (connections & waypoints)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce** ("Select" row) and **3. Feature Scope → MVP → Canvas & editing** ("marquee select; cut/copy/paste/delete; **per-user undo/redo**; snap-to-grid"). Snap-to-grid is deferred to Job 014 (grouped with the visual pass) unless you find it's cheap to do here — use judgement, but don't block this job on it either way.

## Scope

In scope:
- Click-to-select a single node/edge.
- **Right-click-drag marquee** for multi-select (note: right-click-drag, not left — this is called out specifically in PLAN.md because left-click-drag is reserved for panning/other gestures).
- Standard keybinds: cut, copy, paste, delete (and select-all) for the current selection, operating on nodes, their internal edges, and edges between selected nodes.
- Copy/paste must correctly regenerate IDs for pasted nodes (new `nodeId`s) while preserving relative position offsets and internal edge topology (edges between two copied nodes should also be copied with new deterministic `edgeId`s derived from the new node IDs; edges to non-copied nodes should not be pasted).
- **Per-user undo/redo** using the `Y.UndoManager` set up in Job 007 — this is the first job that actually surfaces undo/redo in the UI (keybinds + wiring), and per PLAN.md it must be per-user (each collaborator's undo stack only undoes their own changes, which `Y.UndoManager`'s `trackedOrigins` mechanism supports — tag each local transaction with the local user/session as its origin).

Out of scope:
- Snap-to-grid (Job 014, unless trivially bundled here — worker's call).
- Multiplayer-aware undo semantics beyond what `Y.UndoManager`'s local `trackedOrigins` already gives you for a single local user — true multi-client undo isolation is exercised for real in Job 020+ once there are multiple clients; this job just needs the mechanism correctly wired for one user.

## Deliverables

- Selection state (single + marquee) wired into the canvas.
- Cut/copy/paste/delete keybinds operating correctly on nodes + their edges.
- Undo/redo keybinds wired to the `Y.UndoManager` from Job 007.
- Tests: paste produces new IDs with correct relative positions and correctly-scoped internal edges; undo after a multi-node delete restores everything in one step; redo re-applies it.

## Acceptance criteria

- Marquee select via right-click-drag selects exactly the nodes/edges under the marquee.
- Copy-paste of a group of connected nodes preserves their internal wiring with fresh IDs, and does not duplicate edges to nodes outside the copied set.
- Undo/redo correctly round-trips through node moves, adds, deletes, and edge changes, matching the granularity a user would expect (one user action = one undo step, even if it touched multiple Yjs maps — verify the transaction grouping from Job 007 achieves this).
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
