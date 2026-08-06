# Job 018: Solver Web Worker host

**Phase:** 4 · Calculators
**Status:** Not started
**Depends on:** 017 (`packages/solver`), 016 (end of Phase 3 — needs a stable, persisted canvas to solve against)

## Context

Read [`PLAN.md`](../PLAN.md) section **5. Real-Time Sync Architecture → The multiplayer-specific hazard: the solver**, points 1-3 specifically (point 4, determinism, was already addressed in Job 017). Also **7. Project Structure**'s `apps/web/src/workers/` entry and **9. Verification**'s performance budget ("Basic solve under 200 ms").

This job is single-player-safe worker infrastructure — running the pure `packages/solver` functions off the main thread, debounced, cancellable, with dirty-subgraph caching. It does not yet need to handle multiple remote collaborators triggering solves (Job 020+), but must be architected so that works later without rework.

## Scope

In scope:
- A Web Worker (`apps/web/src/workers/solverWorker.ts`) that imports `packages/solver` and exposes a message-based API: submit a snapshot + mode, receive a result or a cancellation ack.
- Debounce (~150ms per PLAN.md) on the main-thread side: canvas edits trigger a debounced re-solve request rather than solving on every keystroke.
- **Cancellable**: if a new solve request arrives before the previous one completes, the in-flight solve is cancelled (the worker should actually stop wasted work, not just discard a late result — since Basic/Manual are fast this may be more about correctness of "only the latest result wins" than actual compute savings, but implement real cancellation semantics since Full mode in Job 023 will need genuine cancellation, and this is the natural place to build that contract).
- **Dirty-subgraph solving**: partition the graph into connected components (outposts already partition the graph per PLAN.md — use container boundaries as the natural partition unit), cache per-component results, and on an edit, only re-solve the component(s) containing the changed node/edge. Cache invalidation must be correct — a change to a node's limit invalidates only its own component; a change that adds/removes an edge crossing a component boundary invalidates both components it touches.
- Show the last result greyed/stale while recomputing (a UI-facing state flag the worker host exposes: `'fresh' | 'stale-recomputing'`) rather than blanking the display — this job wires the state machine; Job 019 consumes it in the summary panel/node highlighting.

Out of scope:
- The actual summary panel and per-node red/orange highlighting UI (Job 019) — this job only needs to expose the result data and staleness state for Job 019 to render.
- Full calculator support (Job 023) — build the cancellation/worker contract to accommodate a slower cancellable solver later, but don't implement Full mode itself.

## Deliverables

- `apps/web/src/workers/solverWorker.ts` — the worker entry point.
- `apps/web/src/workers/useSolver.ts` (or similar) — the main-thread hook/store: debounce, request/cancel lifecycle, dirty-subgraph partitioning and caching, staleness state.
- Tests: cancelling a stale in-flight request and confirming only the latest result is applied; a component-boundary edit invalidates exactly the right cached components (not more, not fewer); a ~200-node/component synthetic snapshot resolves within the performance budget.

## Acceptance criteria

- Rapid sequential edits (simulating fast typing in a limit field) result in exactly one final solve applied, not a queue of stale results racing to update the UI.
- Editing a node in one outpost does not trigger a re-solve of an unrelated, unconnected outpost's cached result (verify via a spy/counter on the solve call).
- Per PLAN.md §9's performance budget: a synthetic 500-node/800-edge factory's Basic solve completes under 200ms end-to-end through the worker (including message-passing overhead, not just `packages/solver`'s raw compute time).
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- Structured-clone cost across the worker boundary can matter at this node count — keep the snapshot payload lean (avoid sending redundant/derived data the worker doesn't need).
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
