# Job 025: Relational projection (proj_nodes / proj_edges)

**Phase:** 6 · Full calculator
**Status:** Not started
**Depends on:** 024 (priority node UI — last of Phase 6's feature work; this job is the phase's data-layer close-out)

## Context

Read [`PLAN.md`](../PLAN.md) section **4. Data Model → Relational projection (read-only, Phase 6)** in full, including the exact `proj_nodes`/`proj_edges` SQL and the "Rational storage" callout about canonical `"n/d"` strings vs `double precision` companion columns. This table exists to let the server query factories (search, a future public gallery, analytics) without instantiating Yjs — it is explicitly **never written by the client and never a source of truth**.

## Scope

In scope:
- Migrations for `proj_nodes` and `proj_edges` exactly as specified in PLAN.md §4.
- A materialization job/process (server-side only, in `apps/api` or `apps/realtime`) that reads a project's current Yjs doc state and writes/upserts the equivalent rows into `proj_nodes`/`proj_edges`, running on a debounce (per PLAN.md: "Materialized from the CRDT on a debounce") — reasonable to hook this into the same debounced-flush point Job 015/020 already use for persistence, rather than inventing a new trigger mechanism.
- Correct handling of the rational-storage rule: `limit_exact`/`clock_exact` store the canonical `"n/d"` string (via `packages/rational`'s formatter, Job 002) as the lossless source; `limit_approx`/`clock_approx` store a `double precision` companion **derived from, never computed independently of,** the exact value — used only for sorting/filtering.
- MultiMachine variant resolution into `machine_name` (e.g. `'Miner Mk.2'`) per PLAN.md's example — reuse `packages/gamedata`'s resolver from Job 003 rather than re-deriving it.
- A cleanup path: when a project's Yjs doc changes such that nodes/edges are removed, the projection must reflect deletions too (not just accumulate stale rows) — e.g. a full replace-on-materialize per project, or a diff-based upsert+delete; use judgement, but staleness must not be possible.

Out of scope:
- Any consumer of this projection (search UI, public gallery, analytics) — those are later-phase features (PLAN.md §3's "Later phases": "public project gallery"); this job only builds the projection itself and proves it's correct, not anything that queries it for a user-facing feature.
- Any change to the CRDT being the source of truth — this job must not introduce a path where `proj_nodes`/`proj_edges` data flows back into the Yjs doc.

## Deliverables

- Migrations for `proj_nodes`, `proj_edges`.
- Materialization logic, debounced, hooked into the existing persistence-flush pipeline.
- Tests: materializing a known small factory produces exactly the expected rows; `limit_exact`/`clock_exact` round-trip through `packages/rational`'s parser back to the original value; deleting a node in the Yjs doc results in its row being removed from `proj_nodes` on the next materialization (not orphaned); MultiMachine resolution produces correct `machine_name` values.

## Acceptance criteria

- For a factory containing a MultiMachine node (e.g. a Miner Mk.2 on a Pure node), `proj_nodes.machine_name` correctly reads `'Miner Mk.2'` (or the equivalent resolved variant string), `purity` is set correctly, and `limit_exact` is the exact canonical fraction string.
- `limit_approx`/`clock_approx` values, when parsed back and compared, are consistent with (never contradict) their `_exact` counterparts — write a test asserting `parseFloat(exact-as-decimal) ≈ approx` within float precision.
- Deleting nodes/edges in the live doc results in their removal from the projection after the next debounced materialization — no stale rows persist.
- Client code has zero write access to `proj_nodes`/`proj_edges` (verify no client-facing API route exposes writes to these tables).
- `pnpm --filter api test` passes.

## Notes for the worker

- This job closes out Phase 6. When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
