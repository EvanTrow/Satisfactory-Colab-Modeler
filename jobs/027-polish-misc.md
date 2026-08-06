# Job 027: Auto-round, connection styles, minimap

**Phase:** 7 · Polish & deploy
**Status:** Not started
**Depends on:** 026 (blueprints)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce → Auto-round** row and section **3. Feature Scope → Later phases** ("auto-round mode · … · connection style options (Direct/Curves/Horizontal/Vertical) · pop-out summary windows"). This job bundles several smaller, independent polish features that share the trait of being explicitly deferred to "Later phases" in PLAN.md §3.

## Scope

In scope:
- **Auto-round**: a per-node toggle that continuously solves clock speed so machine count lands on a whole number, per PLAN.md's exact description — "Manually touching clock or limit switches it off. Signalled by black field backgrounds." Implement using the clock-snapping math already built in Job 010, but made continuous/automatic rather than only triggered by the ± buttons, and wire the specific "manual touch disables it" and "black background signals it's on" behaviors exactly.
- **Connection style options**: Direct / Curves / Horizontal / Vertical edge rendering, selectable via `settings.connectionStyle` (already in the Job 007 CRDT schema — this job is the first to give it a real UI and rendering effect).
- **Minimap**: React Flow's built-in minimap component, styled to match the Job 014 visual pass, toggleable.
- **Pop-out summary windows**: the summary panel (Job 019) can be popped into a separate browser window (or an equivalent "detached panel" UX — `window.open` with a mounted React root is the simplest approach) so it stays visible while the main window is used for editing.

Out of scope:
- i18n (Job 028), accessibility (Job 029), deployment (Job 029).

## Deliverables

- Auto-round toggle + continuous-solve wiring + black-background visual signal.
- Connection style selector + rendering support for all four styles.
- Minimap toggle.
- Pop-out summary window.
- Tests: auto-round correctly disables on manual clock/limit edit; auto-round correctly maintains whole-machine-count as upstream limits change; each connection style renders distinctly and correctly routes through existing waypoints (Job 011).

## Acceptance criteria

- Toggling auto-round on a node, then changing an upstream limit that would otherwise leave a fractional machine count, results in the node's clock automatically adjusting to restore a whole number, with the black-background signal visible.
- Manually editing the clock or limit field while auto-round is on immediately disables it (verify the toggle state updates, not just that the value stops re-adjusting).
- All four connection styles render correctly and remain compatible with existing waypoints from Job 011.
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
