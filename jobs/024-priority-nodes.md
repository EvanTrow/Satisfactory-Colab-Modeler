# Job 024: Priority Splurger node type & progress/STOP UI

**Phase:** 6 · Full calculator
**Status:** Not started
**Depends on:** 023 (Full calculator solver logic)

## Context

Read [`PLAN.md`](../PLAN.md) section **3. Feature Scope → Specialty node types** (Splurger / Priority Splurger / Priority Splitter / Priority Merger definitions) and section **2**'s note that "all connection points act as splitters or mergers by default" — meaning an *explicit* Splurger node is "usually unnecessary" and mainly exists to expose priority-tier configuration explicitly. This job surfaces the UI for the solver mechanism Job 023 already implemented.

## Scope

In scope:
- A new node kind, `splurger` (per the CRDT schema's `nodes.kind` field from Job 007 — extend the type union), with two priority tiers: top tier drains first, bottom tier takes overflow, matching PLAN.md's exact description. Reuse `nodes.priorityOrder: Y.Array<portId>` (already defined in Job 007's schema) to store tier ordering.
- Node UI for the Splurger: visually distinct from a recipe node (no machine/recipe, just port routing + priority configuration), with a way to assign each connected port to the top or bottom tier and reorder within a tier.
- Creation entry point: add "Splurger" (and its Priority Splitter / Priority Merger variants, if these are meaningfully different node kinds rather than just a Splurger with only-inputs or only-outputs used — use judgement matching PLAN.md's phrasing, which lists them almost interchangeably) to the Recipe Chooser's specialty-machine list (Job 009's left pane) or an equivalent creation path.
- **STOP button + progress UI** for Full-mode solves: since Job 023's solver reports progress and supports cancellation, wire a visible "Solving… [STOP]" affordance (matching PLAN.md's framing: "the original's `STOP` button is the same affordance" as the worker cancellation from Job 018) into the summary panel (Job 019) or wherever solve status is surfaced, active specifically when in Full mode.
- Solver-mode selector: if not already exposed, add the UI to switch between None/Manual/Basic/Full (per PLAN.md's four-mode table) — this may already partially exist from Job 019's settings UI; extend it to include Full now that it's implemented.

Out of scope:
- Further solver logic changes — this job is UI/node-type surface only, consuming Job 023's already-correct solver behavior.
- AWESOME Sink, Storage Container, Dimensional Depot Uploader, Space Elevator phase, Any Part node types — not mentioned as part of this job's scope; if time permits and it's a natural extension of the Splurger node infrastructure, flag as a follow-up rather than silently expanding scope.

## Deliverables

- `apps/web/src/canvas/nodes/SplurgerNode.tsx` (or similar) with priority-tier UI.
- Splurger creation path via the Recipe Chooser or equivalent.
- STOP/progress UI wired to Job 023's cancellation and progress-reporting API.
- Solver-mode selector including Full.
- Tests: creating a Splurger and configuring tiers produces the correct `priorityOrder` in the CRDT doc; solving a factory with a Splurger in Full mode produces the top-drains-first/bottom-overflow behavior verified at the solver level in Job 023, now confirmed reachable end-to-end through the UI.

## Acceptance criteria

- A user can add a Splurger node, wire multiple outputs to it, assign priority tiers, switch to Full mode, and see the resulting flow respect priority (top tier fully satisfied before bottom tier receives anything), matching Job 023's solver tests.
- Switching to Full mode on a large/slow factory shows the "Solving…" state with a working STOP button that actually halts computation (per Job 023's cancellation contract).
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
