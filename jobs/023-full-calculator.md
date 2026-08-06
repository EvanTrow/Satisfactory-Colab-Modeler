# Job 023: Full calculator (splitter/merger priority LP)

**Phase:** 6 · Full calculator
**Status:** Not started
**Depends on:** 022 (end of Phase 5/MVP)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce → The four calculators** table (the "Full" row: "even-split preference **and** priority nodes", "Can be slow; cancellable") and section **8**'s Phase 6 row ("splitter/merger even-split preference and priority splitters/mergers as an exact-rational LP... Full-mode results match the desktop tool on a shared benchmark set"). This is flagged in PLAN.md §8 as the highest-variance phase — budget accordingly and don't be afraid to timebox/checkpoint with the user if the LP formulation proves harder than expected.

## Scope

In scope:
- Extend `packages/solver` (Job 017) with a **Full** mode: entered values are limits (like Basic), but the solver additionally models:
  - **Even-split preference**: at a splitter (any node with multiple outgoing edges of the same part, per PLAN.md's "all connection points act as splitters or mergers by default"), flow should prefer to split evenly across outputs unless downstream constraints force otherwise.
  - **Priority nodes**: explicit priority splitters/mergers (modeled generically here; the dedicated Priority Splurger *node type* with UI is Job 024 — this job needs the solver to support two priority tiers in its model even before that UI exists, since Job 024 will just be surfacing controls for a mechanism this job must already compute correctly: "top drains first, bottom takes overflow").
  - Formulate this as an **exact-rational linear program** — use `packages/rational` (Job 002) throughout, no floating-point in the constraint/objective solving itself (only the existing power-calculation float boundary from Job 002 remains float, as established in Job 017).
- **Cancellable**: per the table, Full mode "can be slow" — the solver must support genuine mid-computation cancellation (a cooperative check inside the LP iteration loop, not just a post-hoc discard), building on the cancellation contract Job 018 already established for the worker host.
- Progress reporting: since Full can be slow, the solve function should be able to report incremental progress (even coarse-grained, e.g. iteration count or phase name) for Job 024's STOP/progress UI to consume.
- Benchmark test suite: construct known factories with documented expected splitter/priority behavior (matching what the real desktop Satisfactory Modeler would compute, if reference outputs are obtainable from the docs/community; otherwise hand-derive expected results using the even-split-preference and priority rules as specified) and assert Full mode matches.

Out of scope:
- The Priority Splurger node type's UI (limit fields, priority-order editing, the actual node component) and the STOP-button UI — Job 024.
- `proj_nodes`/`proj_edges` relational projection — Job 025.

## Deliverables

- `packages/solver/src/full.ts` — the LP-based Full-mode calculator, exact-rational throughout.
- Cancellation + progress-reporting API additions to the solver's public interface.
- Benchmark/golden-value tests for even-split preference and priority-tier behavior.

## Acceptance criteria

- Per PLAN.md §8's Phase 6 exit criterion: "Full-mode results match the desktop tool on a shared benchmark set" — at minimum, match hand-derived expected results for a documented set of even-split and priority-tier test cases (flag in Handoff notes if no real desktop-tool reference data was available to compare against, and what was used instead).
- Cancelling a slow Full-mode solve actually stops computation promptly (verify via a timing test — cancellation should take effect within one LP iteration, not run to completion regardless).
- All arithmetic in the LP formulation and solution stays in exact `Rational` — verify no `number` values leak into the constraint/objective computation path (only the pre-existing power boundary is exempt).
- `pnpm --filter solver test` passes, including the new Full-mode suite.

## Notes for the worker

- This is explicitly the highest-variance job in the roadmap. If the LP formulation for priority splitters turns out to need a significantly different approach than expected, flag that clearly in Handoff notes rather than shipping a partial/incorrect implementation.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
