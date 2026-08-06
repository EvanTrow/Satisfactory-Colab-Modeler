# Job 020: Hocuspocus server, ticket auth & roles

**Phase:** 5 · Multiplayer
**Status:** Not started
**Depends on:** 019 (end of Phase 4 — multiplayer is built on top of a working solo editor with a working solver)

## Context

Read [`PLAN.md`](../PLAN.md) section **5. Real-Time Sync Architecture → Server** and section **6. Discord OAuth2 Flow → Tying sessions to the WebSocket layer** in full — the ticket-issuance flow, the `onAuthenticate` re-verification, and the revocation approach are all specified precisely there. This is the first Phase 5 job; it stands up the transport, later jobs (021, 022) add presence and integrity on top of it.

## Scope

In scope:
- Real implementation of `apps/realtime` (currently a placeholder from Job 001): a Hocuspocus server with:
  - `onAuthenticate`: validates the short-lived ticket JWT (signature + TTL + `projectId` match), attaches `{ userId, role }` to the connection context.
  - `onLoadDocument` / `onStoreDocument`: wired to the persistence logic built in Job 015 (reuse that module rather than reimplementing load/append/compact).
  - Per-connection `readOnly` flag: `role === 'viewer'` connections must be genuinely read-only — writes from a viewer connection must be dropped server-side, not merely hidden in the client UI (this is explicitly called out as a required test in PLAN.md §9).
- `GET /api/realtime/ticket?projectId=…` in `apps/api` (authenticated via the session cookie from Job 005): resolves the caller's role from `project_members`/`projects.visibility`, returns a 60-second HS256 JWT `{ sub: userId, projectId, role, jti }`.
- Client wiring: `apps/web`'s Yjs provider switches from Job 015's debounced-REST transport to a live `@hocuspocus/provider` WebSocket connection, fetching a fresh ticket before connecting (and re-fetching on reconnect, since tickets expire in 60s — the client must request a ticket right before opening the socket, not cache one).
- Revocation: when `project_members` changes (e.g. a role downgrade or removal), affected sockets should be force-disconnected. Per PLAN.md, use "a Redis channel (or an in-process bus while single-instance)" — since this is presumably a single-instance deployment at this stage, an in-process event bus is sufficient; document the Redis upgrade path in a comment but don't build it now unless trivial. Also implement the belt-and-braces hourly role re-verification mentioned in PLAN.md §6.

Out of scope:
- Awareness/presence (cursors, avatars, selection) — Job 021.
- The integrity reducer pass — Job 022 (though `onStoreDocument`/`onLoadDocument` should be structured so Job 022 can slot the reducer in cleanly).
- Cross-instance Redis awareness extension — only the revocation-bus concept needs a documented upgrade path, not a real Redis integration, unless the deployment is already multi-instance (it isn't, per PLAN.md's "single container host").

## Deliverables

- `apps/api/src/routes/realtime.ts` — the ticket-issuance endpoint.
- `apps/realtime/src/server.ts` — the Hocuspocus server with `onAuthenticate`/`onLoadDocument`/`onStoreDocument`/readOnly wiring.
- Client provider switch in `apps/web` from REST-debounce (Job 015) to live WebSocket, with ticket fetch-then-connect.
- Revocation bus (in-process) + hourly re-verification.
- Tests: viewer-role writes are dropped server-side (attempt a write over a read-only connection and assert the document is unchanged); expired/invalid tickets are rejected at `onAuthenticate`; a role downgrade force-disconnects the affected socket.

## Acceptance criteria

- Per PLAN.md §9's Auth verification bullet: "a viewer's WebSocket is genuinely read-only (attempted writes must be dropped server-side, not merely hidden in the UI)" — write an explicit test that bypasses the client UI (e.g. a raw provider/socket in a test) and confirms the server rejects the write.
- Two browser tabs, both authenticated as editors on the same project, can both connect and each other's edits reflect live for both (basic 2-client happy path, ahead of Job 021's presence UI).
- A project owner revoking a member's access force-disconnects that member's active session within a reasonable window.
- `pnpm --filter api --filter realtime test` pass.

## Notes for the worker

- Reuse Job 015's persistence module as-is inside `onLoadDocument`/`onStoreDocument` rather than duplicating load/append/compact logic in `apps/realtime`.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
