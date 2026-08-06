# Job 022: Integrity reducer + sharing UI

**Phase:** 5 · Multiplayer
**Status:** Not started
**Depends on:** 021 (presence)

## Context

Read [`PLAN.md`](../PLAN.md) section **5. Real-Time Sync Architecture → Integrity reducer** in full, and section **4**'s `project_invites` table. This is the last Phase 5 job and the one that makes concurrent editing actually safe — it also finally builds the sharing/invite UI that Job 006 deliberately deferred.

## Scope

In scope:
- The integrity reducer, as a function in `packages/ydoc` (extending Job 007's package — this is the payoff of the `origin: 'integrity'` hook reserved there): run after every transaction, on **both client and server**, inside a transaction tagged `origin: 'integrity'`:
  - Delete edges whose `fromNode` or `toNode` no longer exists.
  - **Reparent** orphaned nodes to the root container rather than deleting them (Job 013 already implemented this for single-user outpost deletion — generalize/reuse that logic here for the concurrent case, e.g. container deleted by user A while user B has a node inside it).
  - Clamp `shards` to the current machine's `MaxProductionShards`; drop ports the current recipe doesn't have (handles: user A changes a node's recipe while user B has an edge wired to a port that no longer exists on the new recipe).
  - Deduplicate edges (a no-op given Job 007's deterministic `edgeId`, but keep it as an explicit backstop per PLAN.md's own framing).
- Wire the reducer into `apps/web`'s local transaction pipeline (client-side pass) and into `apps/realtime`'s `onStoreDocument`/document lifecycle (server-side pass, from Job 020) — "running it on the server too means a malicious or buggy client can't persist a corrupt document."
- **CRDT convergence fuzz test** per PLAN.md §9: generate random concurrent operation sequences across N in-memory `Y.Doc`s, apply in randomized orders, assert (a) all docs are byte-identical (`Y.encodeStateAsUpdate` comparison) and (b) every integrity invariant holds (no dangling edges, no orphaned nodes, shards within range).
- Sharing UI (the piece deliberately deferred from Job 006): invite creation (`project_invites` — token, role, expiry, max-uses), a share-by-link flow, and a role-management view (list `project_members`, change role, remove member) in `apps/web`, wired to `apps/api` routes.
- Connection-status UI: a visible indicator for connected / reconnecting / offline state on the live WebSocket connection from Job 020.

Out of scope:
- Anything already covered by Jobs 020/021 (transport, presence).

## Deliverables

- `packages/ydoc/src/integrity.ts` — the reducer, covering all four repair rules above.
- Client-side wiring (runs after local transactions) and server-side wiring (runs in `apps/realtime`'s document lifecycle).
- `apps/api/src/routes/invites.ts` (or similar) — invite CRUD + redemption; `project_members` role management routes.
- `apps/web` sharing UI: create/copy invite link, manage members/roles.
- Connection-status UI component.
- CRDT convergence fuzz test suite in `packages/ydoc`.

## Acceptance criteria

- Per PLAN.md §9's CRDT convergence fuzzing requirement and §8's Phase 5 exit criterion: "Two browsers edit one factory concurrently; concurrent delete-vs-connect converges with no dangling edges" — build this as an actual automated test (two in-memory docs, or two real client connections in a test harness), not just a manual check.
- The fuzz test suite runs a meaningful number of randomized concurrent-operation sequences (e.g. hundreds) with zero invariant violations.
- A malicious/buggy client that sends a document with a dangling edge (bypass the client-side reducer deliberately in a test) is repaired server-side before persistence — verify the corrupt state never lands in `project_doc_state`/`project_doc_updates`.
- Creating a share link, having a second (unauthenticated) user redeem it, correctly grants the configured role and respects `max_uses`/`expires_at`.
- `pnpm --filter ydoc --filter api --filter web test` all pass.

## Notes for the worker

- This job closes out Phase 5 (the MVP, per PLAN.md §8: "Phases 0-5 are the MVP"). Worth a broader smoke test across the whole app — auth, projects, canvas, solver, multiplayer — before Phase 6 work begins.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
