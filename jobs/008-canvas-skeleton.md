# Job 008: Canvas skeleton (React Flow + local Yjs doc)

**Phase:** 2 · Solo canvas editor
**Status:** Not started
**Depends on:** 007 (`packages/ydoc`)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce** (pan/zoom row) and **7. Project Structure** (`apps/web/src/canvas/`, key-libraries table: `@xyflow/react`). This job wires React Flow to a **local, in-memory** Yjs document (via `packages/ydoc` from Job 007) with no persistence and no game data yet — just the empty canvas that later jobs populate with real nodes.

## Scope

In scope:
- `apps/web/src/canvas/` setup: a React Flow `<ReactFlow>` instance backed by a Zustand store (per PLAN.md's "State" row: "Zustand for ephemeral UI state only — the document lives in Yjs") that subscribes to the `packages/ydoc` document's `nodes`/`edges`/`containers` maps and keeps React Flow's node/edge arrays in sync via Yjs observers.
- Infinite pan/zoom canvas (React Flow's built-in behavior is sufficient — drag background to pan, scroll wheel to zoom, matching PLAN.md §2).
- A route in `apps/web` that mounts the canvas for a given project (for now, project ID can come from the route param but the doc itself is created fresh in memory each load — no fetch, no persistence; that's Job 015).
- The Zustand↔Yjs sync must be bidirectional at the wiring level even though nothing populates it yet: a manually-added test node (e.g. via a dev-only button or test harness) must appear on canvas, and dragging it must write the new `x,y` back into the Yjs doc.
- Empty-canvas state / placeholder background.

Out of scope:
- Recipe Chooser, real recipe nodes (Jobs 009/010).
- Connections/waypoints (Job 011).
- Selection, cut/copy/paste/undo (Job 012).
- Outposts navigation (Job 013).
- Any visual/theming polish (Job 014) — functional plumbing only here.
- Persistence of any kind (Jobs 015/016).

## Deliverables

- `apps/web/src/canvas/CanvasView.tsx` (or similar) rendering `<ReactFlow>` bound to the Yjs-backed store.
- `apps/web/src/canvas/useYjsSync.ts` (or similar) — the Zustand store + Yjs observer wiring.
- A route (e.g. `/p/:shortId/edit`) mounting the canvas.
- A minimal manual test path (dev button, Storybook story, or test) proving a node added via the ydoc API renders on canvas and position edits round-trip back into the doc.

## Acceptance criteria

- Panning and zooming work smoothly on an empty canvas.
- Programmatically calling `packages/ydoc`'s `addNode` (from Job 007) results in a node rendering on the React Flow canvas without a page reload.
- Dragging a node in React Flow updates that node's `x`/`y` in the underlying Yjs document (verify by reading the doc state after a drag in a test or dev console).
- No direct Yjs map/array manipulation happens inside `apps/web` — all doc access goes through `packages/ydoc`'s public API (per Job 007's architectural constraint).
- `pnpm --filter web dev` runs the canvas with no console errors; `pnpm --filter web build/typecheck` pass.

## Notes for the worker

- This is plumbing-only — resist the urge to build real node visuals here; Job 010 owns node UI.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
