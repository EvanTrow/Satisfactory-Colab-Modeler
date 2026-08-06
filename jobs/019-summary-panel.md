# Job 019: Summary panel, validity highlighting & number formats

**Phase:** 4 · Calculators
**Status:** Not started
**Depends on:** 018 (solver worker host)

## Context

Read [`PLAN.md`](../PLAN.md) section **3. Feature Scope → MVP → Calculation** ("red highlighting for invalid values and orange for non-matching; summary panel with made/used/unmade/unused, power made/used/net, sink points, and cost-to-build, scoped to Everything / Current Outpost / Selected") and section **2**'s mention of scoped operations (`Everything` / `Current Outpost` / `Current Outpost & Below` / `Selected` / `Selected & Below` / `Selected + Connected`) — the summary panel needs at least the three scopes named in §3's MVP line (Everything / Current Outpost / Selected); the fuller scope-operation set is fine to leave as a later refinement if it doesn't block this job, but note any gap in Handoff notes.

This job closes the loop Job 010 left open (recall its stopgap client-side rate display) by wiring real solver output into the node cards and adding the summary panel.

## Scope

In scope:
- Replace Job 010's stopgap per-node rate display with real values from `packages/solver`'s (Job 017) results, delivered via the worker host (Job 018).
- Red highlighting for invalid values (e.g. a Manual-mode mismatch, or a limit that can't be satisfied) and orange for non-matching (per PLAN.md's specific two-color scheme — don't conflate them) on the affected node fields/ports.
- A summary panel component showing: made / used / unmade / unused (per-part quantities), power made / used / net, sink points, and cost-to-build (using each machine's `Cost` array from `packages/gamedata`, Job 003).
- Scope selector on the summary panel: **Everything**, **Current Outpost**, **Selected** at minimum (per §3's MVP line) — computing the aggregate over the correct node/edge subset for each scope.
- Number-format settings UI (fraction vs decimal, digit count, rounding mode) wired to `packages/rational`'s formatter (Job 002) and the CRDT `settings.numberFormats` field (Job 007) — this is the UI layer on top of formatting primitives that already exist.
- Wire the worker host's `'fresh' | 'stale-recomputing'` state (Job 018) into the summary panel and node cards as a greyed/stale visual state during recompute.

Out of scope:
- Full-mode-specific summary details (priority splitter overflow reporting etc.) — Job 023/024.
- The remaining scope operations beyond the three MVP ones, if not trivially included.
- Per-user or role-based summary customization — not in PLAN.md's scope.

## Deliverables

- `apps/web/src/panels/SummaryPanel.tsx` with scope selector and all listed aggregate figures.
- Node card updates (in `RecipeNode.tsx` from Job 010) consuming real solver results instead of the stopgap math, plus red/orange highlighting.
- Number-format settings UI.
- Tests: summary aggregates match hand-computed values for a small known factory; scope filtering correctly includes/excludes nodes; red vs orange highlighting triggers on the correct distinct conditions (don't just test that *some* highlight appears).

## Acceptance criteria

- Per PLAN.md §8's Phase 4 exit criterion: "Golden-value tests pass against known Satisfactory ratios; a ~200-node factory solves under 200 ms" — this job is where that's verified end-to-end through the UI (Job 017/018 verified it at the package/worker level; this job confirms the full pipeline renders correctly and within budget).
- Building a small factory with an intentionally-invalid limit shows red on the correct field; a Basic-mode split imbalance (if applicable) shows orange, not red.
- Summary panel figures are correct for a hand-verifiable small factory (e.g. the 30 Iron Ore → 30 Iron Ingot case from PLAN.md §9) across all three scopes.
- Changing number-format settings immediately re-renders all displayed values in the new format without a full page reload.
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- This job closes out Phase 4. This is a natural point for a broader manual smoke test of Phases 2-4 together (build a real multi-outpost factory, verify it solves and displays correctly) before Phase 5 (multiplayer) starts building on top.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
