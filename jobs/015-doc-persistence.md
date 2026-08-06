# Job 015: Yjs ↔ Postgres persistence

**Phase:** 3 · Persistence
**Status:** Not started
**Depends on:** 014 (visual pass — end of Phase 2), 006 (project CRUD, needs `projects` to attach documents to)

## Context

Read [`PLAN.md`](../PLAN.md) section **4. Data Model → Canvas state: snapshot + incremental log** in full — the exact split between `project_doc_state` (compacted snapshot) and `project_doc_updates` (append-only log), the load/write/compaction algorithm described right after the SQL, and `project_versions`. This is the job that turns Phase 2's "refresh loses it" canvas into something durable.

## Scope

In scope:
- Migrations for `project_doc_state`, `project_doc_updates`, and `project_versions` exactly as specified in PLAN.md §4 (add to `db/migrations/`, building on Job 004's setup).
- `apps/api` (or a shared persistence module usable by both `apps/api` and, later, `apps/realtime`) implementing:
  - **Load**: snapshot + every log row with `id > seq`, merged via `Y.applyUpdate`, returning a hydrated `Y.Doc`.
  - **Write**: append-only — every debounced flush from the client inserts one row into `project_doc_updates`, never rewrites the document.
  - **Compaction**: a background job (can be a simple periodic task for now, doesn't need a full job queue) that folds log rows into the snapshot once the log exceeds ~200 rows for a project, then deletes the folded rows, updating `seq`.
- Wire the client (`apps/web`, using the local Yjs doc from Job 007/008) to: on project open, fetch and apply the persisted state; on local changes, debounce (e.g. ~1-2s) and POST the incremental update to the server for appending. This job does **not** yet require a live WebSocket — a simple debounced REST push/pull is sufficient groundwork; Job 020 (Hocuspocus) will later replace/extend this transport, not the storage model, which stays as-is.
- Fix Job 006's "duplicate project" limitation now that `project_doc_state` exists: duplicating a project should also duplicate its current doc snapshot.

Out of scope:
- Real-time multi-client sync over WebSocket (Job 020) — this job is single-client load/save durability only.
- `y-indexeddb` local caching and the autosave *indicator* UI, and `project_versions` restore UI (Job 016).
- Any use of `project_versions` beyond having the table and an insert path ready for Job 016 to build restore UI on top of.

## Deliverables

- Migrations for the three tables.
- Server-side load/write/compaction logic (with the compaction threshold configurable, defaulting to ~200 rows per PLAN.md).
- Client-side debounced push + on-open pull wired into the canvas from Job 008.
- Fixed project duplication (Job 006) to include the doc snapshot.
- Tests: load = snapshot + logs merges correctly; compaction folds and deletes correctly and preserves identical resulting doc state (byte-compare `Y.encodeStateAsUpdate` before/after compaction); a crash mid-flush loses at most one debounce window (simulate by not compacting and reloading from snapshot+partial-log).

## Acceptance criteria

- Per PLAN.md §8's Phase 3 exit criterion: "Factory survives reload and server restart" — build a factory in the canvas, reload the page, and it's still there; restart the API/DB containers and it's still there.
- Compaction is verified to produce a byte-identical merged document compared to not compacting (i.e. compaction is purely an optimization, never lossy).
- Writes are O(change) — verify a single node move results in one small `project_doc_updates` row, not a full-document rewrite.
- `pnpm --filter api --filter web test` passes.

## Notes for the worker

- Keep the persistence module's interface transport-agnostic where reasonable (a plain "given bytes, load/append/compact" API) since Job 020 will likely want the same logic accessible from `apps/realtime`, not just `apps/api`'s REST layer.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
