# Job 021: Presence (cursors, avatars, selection, field indicators)

**Phase:** 5 · Multiplayer
**Status:** Not started
**Depends on:** 020 (Hocuspocus server)

## Context

Read [`PLAN.md`](../PLAN.md) section **5. Real-Time Sync Architecture → Presence** in full — the exact Awareness state shape is specified there — and section **3. Feature Scope → MVP → Multiplayer** ("presence avatars, per-user cursors, and selection highlighting; soft field-level indicators when someone else is typing in a field").

## Scope

In scope:
- Yjs **Awareness** state per the PLAN.md-specified shape: `{ userId, displayName, avatarUrl, color, cursor: { x, y, containerId } | null, selection: string[], editingField: { nodeId, field } | null }`. Confirm this is genuinely ephemeral — never written to Postgres, only ever exchanged over the live Awareness protocol.
- Color derivation from `userId` hash (deterministic per-user color, consistent across sessions/reconnects).
- Cursor rendering: other users' live cursors rendered on the canvas, **scoped to `containerId`** — a collaborator's cursor should only render when you're viewing the same outpost/container they are (per the schema's explicit purpose for that field).
- Selection highlighting: other users' selected nodes get a colored halo matching their presence color.
- Avatar list: a small UI element (e.g. top bar) showing who's currently connected to the project, using `avatarUrl`/`displayName` (sourced from the Discord profile data captured at login, Job 005).
- Soft field-level editing indicators: when another user is actively editing a specific field (e.g. a node's limit field), show a colored ring + their avatar near that field — explicitly a **soft** indicator per PLAN.md, never a hard lock (the local user must still be able to edit the same field; last-write-wins via the CRDT is fine).

Out of scope:
- Hard field locking of any kind — explicitly ruled out by PLAN.md ("hard locks in a CRDT tend to strand fields when a client disconnects uncleanly").
- Persisting any presence data to Postgres.
- Share-by-link/invite UI — Job 022.

## Deliverables

- `apps/web/src/collab/awareness.ts` (or similar) — Awareness state setup, color derivation, local state publishing (cursor position on mousemove, selection on select-change, editingField on focus/blur of relevant inputs).
- Cursor, selection-halo, and avatar-list UI components.
- Field-indicator UI wired to the relevant input components from Job 010 (limit, clock, shards fields).
- Tests: color is deterministic and stable for a given `userId`; cursor rendering correctly filters by `containerId` (a collaborator in a different outpost doesn't show a cursor on your current view); editingField indicator appears/clears correctly on focus/blur, including on ungraceful disconnect (the indicator must clear, not strand, when a peer's connection drops — verify this specifically since it's the exact failure mode PLAN.md warns hard locks suffer from, and soft indicators need to actually clear via Awareness's disconnect semantics).

## Acceptance criteria

- Two browser contexts on the same project show each other's live cursors (correctly container-scoped), selection halos, and avatars in the presence list.
- Disconnecting one client (e.g. closing its tab) clears its presence — cursor, selection, and any field indicator — from the other client within Awareness's normal timeout, with no stranded indicators.
- Both clients can edit the same field concurrently without either being blocked, while still seeing each other's soft indicator while doing so.
- `pnpm --filter web test` passes; manual two-tab verification performed and noted in Handoff notes.

## Notes for the worker

- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
