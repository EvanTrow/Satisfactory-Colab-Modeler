# Job 017: `packages/solver` — Manual/Basic/None calculators

**Phase:** 4 · Calculators
**Status:** Not started
**Depends on:** 002 (`packages/rational`) — does not depend on the canvas/persistence jobs since it's pure logic (per PLAN.md's architectural boundary)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce → The four calculators** table, section **7. Project Structure**'s note ("`packages/solver` takes a plain snapshot and returns plain results. No Yjs import, no DOM."), and **9. Verification**'s "Solver golden values" bullet. This job builds **Manual**, **Basic**, and **None** only — **Full** (with splitter/merger priority as an LP) is explicitly deferred to Phase 6 (Job 023).

## Scope

In scope:
- A plain-data input snapshot type — deliberately **not** Yjs-shaped — representing a solvable graph: nodes (recipe, machine, limit, limitMode, clock, shards), edges (part, fromNode/Port, toNode/Port), and settings (solver mode, multipliers). This is the boundary type that `apps/web`'s worker host (Job 018) will construct from the live Yjs doc each solve.
- **None mode**: trivial — returns no computed values, instant.
- **Manual mode**: per PLAN.md's table, "entered values are the final values you want" (spreadsheet-like) — i.e. the solver in this mode doesn't infer anything; it validates the user-entered limits/clocks are self-consistent along each edge (same part, same rate in vs out at splits/merges) and reports mismatches, using exact `Rational` arithmetic throughout. "No splitter/merger preference modeling" per the table — a node with multiple output edges of the same part just divides evenly for *validation* purposes, it doesn't need to model real splitter behavior since Manual mode doesn't compute quantities from limits, it displays entered ones.
- **Basic mode**: "entered values are limits" — the solver propagates limits through the graph to compute machine counts/rates everywhere, without modeling splitter/merger even-split preference or priority (per the table, "No" on that column). Per PLAN.md §5's correctness requirement: *"the Basic calculator 'may produce inconsistent results when multiple valid solutions exist,' so we must pin a fixed variable ordering and a deterministic pivot rule, or collaborators will see different numbers for identical state."* This determinism requirement is not optional — write it into the algorithm's design explicitly (e.g. process nodes/edges in a stable sort order — by ID — and document the pivot rule in a code comment), and test it by running the same input snapshot through the solver many times / with shuffled-but-logically-equivalent input ordering and asserting identical output.
- Somersloop and generator handling per `packages/gamedata`'s (Job 003) boost formula and generator/power sign conventions — the solver must correctly account for output multiplication from shards and power generation vs consumption.
- Power is computed using the float boundary from `packages/rational`'s `power.ts` (Job 002) — rates stay exact, power is float, per PLAN.md's explicit exactness-boundary note.
- Golden-value tests exactly as specified in PLAN.md §9: 30 Iron Ore/min → 30 Iron Ingot/min; Miner Mk.3 on Pure = 480/min; Manufacturer with 4 somersloops = 2× output at 4× power; a Coal Generator chain's water draw.

Out of scope:
- Full calculator / splitter-merger priority LP (Job 023).
- Web Worker hosting, debouncing, cancellation, dirty-subgraph caching (Job 018) — this package is synchronous pure functions; the worker wrapping is a separate concern.
- Summary panel, highlighting, number formatting UI (Job 019).

## Deliverables

- `packages/solver/src/snapshot.ts` — the plain input type.
- `packages/solver/src/none.ts`, `manual.ts`, `basic.ts` — the three calculator implementations.
- `packages/solver/src/result.ts` — the plain output result type (per-node computed values, per-edge rates, validity flags, summary aggregates: made/used/unmade/unused/power/sink points — enough for Job 019 to render without needing solver internals).
- `packages/solver/src/index.ts` — public API, e.g. `solve(snapshot, mode): SolveResult`.
- Tests: the four golden-value cases from PLAN.md §9, plus a determinism test for Basic mode (same logical input, different orderings, identical output).

## Acceptance criteria

- All four golden-value tests pass exactly (using `Rational` equality, not float approximation, for anything that isn't power).
- Basic-mode determinism test passes: shuffling equivalent input produces byte-identical (or `Rational`-equal) output.
- `solve()` has zero imports from Yjs, React, or any DOM/browser API — verify by checking `packages/solver`'s dependencies contain neither.
- A ~200-node synthetic snapshot solves in well under 200ms synchronously (this package doesn't own the worker/debounce infra from Job 018, but its raw solve speed must support that later budget from PLAN.md §8's Phase 4 exit criterion).
- `pnpm --filter solver test/build/typecheck` pass.

## Notes for the worker

- This is a Phase-4 job but has no dependency on Phase 2/3 UI work — it can in principle be built any time after `packages/rational` and `packages/gamedata` exist, which is why its only hard dependency is Job 002 (it will also want to read `packages/gamedata`'s types, from Job 003, for the somersloop/generator logic, but doesn't need gamedata's *runtime* loading — just its types/pure functions).
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
