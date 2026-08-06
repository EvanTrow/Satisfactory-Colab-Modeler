# Job 009: Recipe Chooser

**Phase:** 2 · Solo canvas editor
**Status:** Not started
**Depends on:** 008 (canvas skeleton), 003 (`packages/gamedata`)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce** ("Add a machine" row) and **3. Feature Scope → MVP → Canvas & editing** (Recipe Chooser filtering requirements). This job adds the entry point for populating the canvas — it doesn't add the full node UI yet (Job 010), just the modal/picker and the "an empty recipe node gets created" wiring.

## Scope

In scope:
- Double-click or right-click on empty canvas opens the Recipe Chooser (per PLAN.md §2's exact interaction — both gestures, not just one).
- Two-pane picker UI: specialty machines on the left (from `packages/gamedata`'s machine list — note MultiMachines like Miner/Oil Extractor/Resource Well Extractor/Geothermal Generator/Space Elevator need their variant selection, e.g. Mk.1/2/3 × purity, exposed here or immediately after selection), filterable recipes on the right.
- Filtering by: name (text search), machine, tier, and an alternate-recipe toggle — all four filters from PLAN.md §3 must work and compose (e.g. text + tier + alternate-only simultaneously).
- Selecting a recipe/machine creates a new node in the current container (root, for now — outpost-scoped placement is Job 013) via `packages/ydoc`'s `addNode` mutation, positioned at (or near) the click location, using a minimal placeholder visual (Job 010 fleshes out the real node card).
- Closing the chooser without selecting (Escape, click-outside) does nothing.

Out of scope:
- The full recipe node visual (ports, limit field, clock, shards) — Job 010.
- Generators-specific UI beyond correctly creating a generator-kind node when a generator recipe is picked (the *rendering* of that distinctly is Job 010's concern).
- Outpost-scoped placement / breadcrumb awareness (Job 013) — chooser always targets whatever the "current container" concept resolves to, which for this job can simply default to root.

## Deliverables

- `apps/web/src/panels/RecipeChooser.tsx` (or similar) implementing the modal, two-pane layout, and all four filters.
- Wiring: double-click and right-click handlers on the canvas background open the chooser at the cursor position.
- On selection, a call into `packages/ydoc`'s node-creation mutation with the correct `recipe`/`machine`/`kind` fields resolved via `packages/gamedata`.
- Tests: filter composition (name + tier + alternate together narrows correctly), MultiMachine variant selection produces the correct resolved `machine` field on the created node.

## Acceptance criteria

- Double-clicking or right-clicking empty canvas opens the chooser at that point; selecting a recipe creates a node at that position and closes the chooser.
- All four filters (name, machine, tier, alternate toggle) work individually and in combination against the real `game_data.json` recipe list (332 recipes, 110 alternates).
- Choosing a MultiMachine-backed recipe (e.g. Miner) correctly prompts for or defaults to a model/purity combination and stores the resolved machine variant on the node.
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- Use `packages/gamedata`'s indices (recipes-by-machine, tier parsing) from Job 003 rather than re-deriving them.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
