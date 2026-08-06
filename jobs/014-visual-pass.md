# Job 014: Visual pass, theming & snap-to-grid

**Phase:** 2 · Solo canvas editor
**Status:** Not started
**Depends on:** 013 (outposts — this is the last job of Phase 2, polishing everything built so far)

## Context

Read [`PLAN.md`](../PLAN.md)'s introduction ("wraps it in the visual polish of [Ferrumium](https://ferrumium.com)") and section **3. Feature Scope → MVP → Canvas & editing** ("snap-to-grid for machines and waypoints") and **→ Platform** ("dark and light themes"). Also review §10.2, the open question on node visual density — it's flagged as "the single biggest UI-feel decision" but is marked as something to settle *before* Phase 2, so check whether it was resolved in an earlier job's Handoff notes; if not, default to the denser Satisfactory-Modeler-style readout (every part row shows a live number) since that's the tool's differentiating trait, and note the assumption clearly in this job's Handoff notes so it can be revisited.

## Scope

In scope:
- Visit https://ferrumium.com (or use existing familiarity) to characterize its visual language — spacing, corner radii, shadows, typography, color restraint — and apply that language to: node cards, the Recipe Chooser modal, canvas background/grid, edges, and toolbar chrome built so far.
- Dark and light theme support across everything built in Jobs 008-013 (Tailwind's dark-mode variant, a theme toggle, and persisted preference — localStorage is sufficient for now, doesn't need to be a DB setting yet).
- Snap-to-grid for both machine nodes and waypoints, driven by the `settings.snapMachines`/`gridMachine{x,y}`/`snapWaypoints`/`gridWaypoint{x,y}` fields already defined in the Job 007 CRDT schema (wire real behavior to fields that so far may be unused).
- General consistency pass: icons render crisply at node scale, hover/focus states are legible in both themes, connection lines and ports read clearly against the grid.

Out of scope:
- Connection style options (Direct/Curves/Horizontal/Vertical) — later phase (Job 027).
- Any new functional behavior beyond snap-to-grid — this is a polish job, not a features job.
- Minimap — later phase (Job 027).

## Deliverables

- Updated styling across `apps/web/src/canvas/`, `apps/web/src/panels/RecipeChooser.tsx`, and shared layout chrome, applying a consistent Ferrumium-inspired visual language.
- Dark/light theme toggle with persisted preference.
- Snap-to-grid implementation for node drag and waypoint drag, respecting the CRDT `settings` fields.

## Acceptance criteria

- The app is visually coherent — consistent spacing/radii/typography — and legible in both dark and light themes (spot-check contrast on text-over-node-background and icon-over-canvas-background combinations).
- Dragging a node with snap-to-grid enabled lands it on grid intersections at the configured spacing; disabling the setting restores free positioning.
- No functional regressions in anything built in Jobs 008-013 — re-run their test suites and manually smoke-test the canvas.
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- This job closes out Phase 2 (per PLAN.md §8's exit criterion: "Build a multi-outpost factory in-browser; refresh loses it (no persistence yet)") — do a full manual smoke test of the whole Phase 2 feature set before marking done, since Phase 3 (Job 015) starts persisting whatever this produces.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
