# Job 016: IndexedDB cache, autosave indicator & version restore

**Phase:** 3 · Persistence
**Status:** Not started
**Depends on:** 015 (Yjs ↔ Postgres persistence)

## Context

Read [`PLAN.md`](../PLAN.md)'s confirmed decisions line in the intro ("local IndexedDB caching but online-to-edit") and section **4. Data Model → Canvas state** (`project_versions` table) and **3. Feature Scope → MVP → Platform** ("autosave"). Also note §3's "Later phases" list includes "version history with restore and named snapshots" as a *later* phase — but `project_versions` itself and a basic save/restore mechanism are reasonable to stand up now since the table exists; use judgement on how much restore UI polish to build here versus deferring further (a functional restore is in scope, a polished history browser with diffing is not).

## Scope

In scope:
- `y-indexeddb` wired into the client so the local Yjs doc persists across page reloads/offline even before the server round-trip completes — per the "online-to-edit" decision, the app still requires a live connection to *edit* (don't build offline-editing support), but the IndexedDB cache should let the canvas render instantly from local cache while the server fetch is in flight, then reconcile.
- Autosave indicator UI: a small status element (e.g. "Saved" / "Saving…" / "Offline — reconnecting") reflecting the debounced-flush state from Job 015.
- `project_versions` writes: an "auto" snapshot on some reasonable cadence (e.g. every N minutes of activity, or every compaction — use judgement) and a "manual" snapshot on an explicit user action (a "Save version" or similar button), both tagged with the correct `kind`.
- A basic restore flow: list a project's versions (timestamp, label, kind), and restoring one creates a new `kind: 'pre_restore'` snapshot of current state first (so restoring is itself non-destructive/undoable at the version-history level), then applies the selected version's `ydoc` bytes as the new current state.

Out of scope:
- Rich version history UI (diffing, named-snapshot management beyond a basic label field) — PLAN.md explicitly defers "version history with restore and named snapshots" polish to a later phase; build the functional minimum.
- Offline editing (queuing local edits while disconnected and syncing later) — out of scope per the "online-to-edit" decision.

## Deliverables

- `y-indexeddb` provider wired into the client's Yjs doc lifecycle.
- Autosave status indicator component.
- Server-side version snapshot creation (auto + manual) and a list/restore API.
- Client UI: a simple version list + restore action, with the automatic `pre_restore` safety snapshot.
- Tests: restoring a version correctly creates a `pre_restore` snapshot first; restored state matches the selected version's bytes exactly.

## Acceptance criteria

- Per PLAN.md §8's Phase 3 exit criterion: "a version can be restored" — verified end to end (create state A, save a version, change to state B, restore, canvas shows state A again, and a `pre_restore` snapshot of B now exists in the version list).
- Reloading the page shows the cached local state instantly (no blank canvas flash) even on a slow network, then reconciles with the server.
- Autosave indicator accurately reflects save state (verify by throttling network in dev tools or an equivalent simulated-latency test).
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- This job closes out Phase 3. Do a full smoke test of reload/restart/restore behavior before marking done, since Phase 4 (solver) builds on top of a canvas assumed to be durable.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
