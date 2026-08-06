# Job 010: Recipe node UI

**Phase:** 2 · Solo canvas editor
**Status:** Not started
**Depends on:** 009 (Recipe Chooser — needs nodes to actually be created first)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce** ("Set a limit", "Clock speed", "Auto-round" rows) and **3. Feature Scope → MVP → Canvas & editing** ("recipe nodes with title, machine icon, per-part input/output rows, limit field, clock-speed field with ± snapping, and somersloop count"). This job builds the real node card that Job 009 currently stubs.

## Scope

In scope:
- A React Flow custom node component rendering, per node:
  - Title (recipe name) and machine icon (from `packages/gamedata`'s icon manifest, Job 003).
  - Per-part rows: one row per `Parts` entry on the recipe, showing icon, part name, and a **live computed rate** — for this job, before the solver exists (Job 017), display the rate as "limit × recipe ratio" using pure client-side math against the node's own `limit`/`clock` fields (not a real graph solve; that's what makes this "Manual"-adjacent display legitimate to build before the solver package exists — document this clearly as a stopgap in Handoff notes, since Job 017-019 will replace/wire it to real solver output).
  - Limit field at the bottom: defaults to parts-per-minute for Miners/AWESOME Sinks, machine-count for everything else (per PLAN.md §2's exact default rule).
  - Clock-speed numeric field with **± buttons that snap clock so machine count lands on a whole number** (minus rounds count up, plus rounds count down), capped at 250% — implement the snapping math using `packages/rational` (Job 002), not floats.
  - Somersloop count field/stepper, capped at the machine's `MaxProductionShards` (from `packages/gamedata`).
  - Input/output ports as distinct connection handles per part (React Flow handles) — ports themselves aren't wired to edges yet (Job 011), but the handle elements must exist and be positioned correctly (inputs left, outputs right, or whatever matches the reference tool's convention).
- Auto-round toggle is **out of scope for this job** (PLAN.md marks it a later phase — "Later phases: … auto-round mode") — only build the manual ± snap behavior described above.
- Red/orange validity highlighting is **out of scope** here too (that depends on solver output, Job 019) — but leave a clearly-named prop/slot (e.g. `validityState`) on the node component so Job 019 can wire it without a rewrite.
- Editing the limit or clock field directly (typing a value) updates the node's Yjs state via `packages/ydoc` mutations.

Out of scope:
- Actual solver-computed rates (Jobs 017-019) — use the documented stopgap math only.
- Connections between nodes (Job 011).
- Multi-select/marquee, cut/copy/paste (Job 012).
- Red/orange highlighting, summary panel (Job 019).
- Visual polish beyond "functionally correct and legible" (Job 014 does the real Ferrumium-inspired pass).

## Deliverables

- `apps/web/src/canvas/nodes/RecipeNode.tsx` (or similar) — the full node card.
- Clock ± snapping logic using `packages/rational`, unit tested against known cases (e.g. clock at 100% with a limit that isn't a whole machine count, pressing "+" should land on the next whole-machine-count clock ≤ current, capped at 250%).
- Limit-mode defaulting logic (ppm for Miner/AWESOME Sink, machine-count otherwise).
- Somersloop stepper respecting `MaxProductionShards` from gamedata.

## Acceptance criteria

- Creating a recipe node (via Job 009's chooser) renders title, icon, part rows, limit field (correctly defaulted), clock field, and somersloop stepper.
- Editing limit/clock/shards updates the underlying Yjs node map (verify by reading doc state after an edit).
- Clock ± snapping produces exact whole-machine-count results, verified with `packages/rational`-based tests, and is capped at 250%.
- Somersloop stepper cannot exceed the resolved machine's `MaxProductionShards`.
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- Keep the stopgap "displayed rate" math isolated (e.g. a single clearly-named function) so it's a one-place swap when Job 019 wires real solver output in.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
