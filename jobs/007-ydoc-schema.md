# Job 007: `packages/ydoc` — CRDT document schema

**Phase:** 2 · Solo canvas editor
**Status:** Not started
**Depends on:** 001 (monorepo scaffold)

## Context

Read [`PLAN.md`](../PLAN.md) section **4. Data Model → The CRDT document schema** in full, plus the "Three deliberate choices" that follow it, and the opening of **8. Phased Roadmap** ("build the canvas on a local Yjs document from day one"). Also read §7's note: "`packages/ydoc` is the only place that knows the CRDT shape. Both `apps/web` and `apps/realtime` import it, so the client and the server's integrity pass can never drift apart." That constraint governs this whole job — nothing outside this package should construct or destructure Yjs maps by hand.

This job builds the document shape only, as a **local-only** Yjs doc (no network, no Hocuspocus — that's Job 020). It's the foundation Job 008 wires into React Flow.

## Scope

In scope:
- `Y.Doc` structure exactly as specified in PLAN.md §4:
  - `meta: Y.Map` — `{ schemaVersion, title, gameDataVersion }`.
  - `settings: Y.Map` — `{ solverMode, inputMultiplier, powerMultiplier, spaceElevatorMultiplier, snapMachines, gridMachine{x,y}, snapWaypoints, gridWaypoint{x,y}, numberFormats, connectionStyle }`.
  - `containers: Y.Map<containerId, Y.Map>` — `{ id, kind: 'root'|'outpost'|'blueprint', parentId, title, color, x, y, copiesLimit }`.
  - `nodes: Y.Map<nodeId, Y.Map>` — `{ id, containerId, kind, recipe, machine, x, y, title, color, limit, limitMode: 'machines'|'ppm', clock, autoRound, shards, purity, beltTier, storageMode, priorityOrder: Y.Array<portId> }`.
  - `edges: Y.Map<edgeId, Y.Map>` — `{ id, containerId, part, fromNode, fromPort, toNode, toPort, waypoints: Y.Array<Y.Map{x,y}>, style, labelPos }`.
- A typed factory function, e.g. `createDocument(): SfmDocument`, wrapping a raw `Y.Doc` with typed accessors — this is the API surface everything else uses instead of touching `Y.Map`/`Y.Array` directly.
- Mutation helpers for every node/edge/container operation the later canvas jobs will need: `addNode`, `updateNode`, `removeNode`, `addEdge`, `removeEdge`, `addContainer`, `removeContainer`, `moveNode`, `addWaypoint`, `removeWaypoint`, etc. — each wrapped in a `doc.transact(...)` call.
- **Deterministic `edgeId`**: implement it as a hash of `(fromNode, fromPort, toNode, toPort)` exactly as PLAN.md §4 point 2 specifies, so concurrent identical-connection drags merge into one edge instead of duplicating.
- A `Y.UndoManager` setup helper, scoped correctly per PLAN.md's later per-user-undo requirement (Job 012 wires this into UI, but the manager itself — including which origins it should/shouldn't track — belongs here since it's part of the doc's public contract). In particular, reserve an `origin: 'integrity'` tag now (per §5's Integrity reducer note) even though the reducer itself is implemented in Job 022 — the undo manager must be configured from day one to exclude that origin from the undo stack.
- Zod (or similar) runtime validators for the shape of each map, used in tests and later by the integrity reducer.
- Unit tests: creating a doc, adding/removing nodes and edges, verifying deterministic edgeId collision behavior (two calls with the same four IDs produce the same edge, not two).

Out of scope:
- Any React/React Flow integration (Job 008).
- The integrity reducer itself (deferred to Job 022, though this job must leave the `origin: 'integrity'` hook in place for it).
- Persistence to Postgres or IndexedDB (Jobs 015/016).
- Hocuspocus / networking (Job 020).

## Deliverables

- `packages/ydoc/src/schema.ts` — type definitions for every map shape above.
- `packages/ydoc/src/document.ts` — `createDocument()` and typed accessors.
- `packages/ydoc/src/mutations.ts` — the mutation helper functions, each transacted.
- `packages/ydoc/src/edgeId.ts` — deterministic edge ID hashing.
- `packages/ydoc/src/undo.ts` — `Y.UndoManager` setup with the `integrity` origin exclusion.
- `packages/ydoc/src/validate.ts` — runtime shape validators.
- `packages/ydoc/src/index.ts` — public API.
- Tests covering doc creation, CRUD mutations, deterministic edge IDs, and undo-manager origin scoping.

## Acceptance criteria

- Two independent calls to the edge-creation helper with identical `(fromNode, fromPort, toNode, toPort)` produce the exact same `edgeId` and, when both applied to the same doc, result in exactly one edge (test this explicitly — it's the concrete mechanism behind PLAN.md's "conflict class eliminated for free" claim).
- All mutation helpers use `doc.transact()` so they batch into single Yjs update events (verify via an `on('update')` listener in tests).
- The `Y.UndoManager` returned by `undo.ts`, when doing/undoing a tracked change, correctly restores prior state, and changes made with `origin: 'integrity'` never appear on the undo stack (write a test for this specifically).
- `pnpm --filter ydoc test/build/typecheck` all pass.

## Notes for the worker

- Nothing outside `packages/ydoc` should ever call `Y.Map`/`Y.Array` constructors directly on doc content — keep that discipline even under time pressure, since it's the architectural guarantee PLAN.md §7 is relying on.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
