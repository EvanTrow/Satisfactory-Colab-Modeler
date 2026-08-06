# Job 007: `packages/ydoc` — CRDT document schema

**Phase:** 2 · Solo canvas editor
**Status:** Done
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

## Handoff notes

**Public API — import everything from `@scm/ydoc`** (JIT package: `main`/`types`/`exports` point at `./src/index.ts`, no build step needed to consume it).

### Types & zod schemas (`./schema`)

One zod schema + `z.infer`'d type per PLAN.md §4 map shape, following `packages/gamedata/src/schema.ts`'s established pattern (schema *is* the type definition):

- `Meta { schemaVersion: number; title: string; gameDataVersion: string }` — `MetaSchema`. `CURRENT_SCHEMA_VERSION = 1` is exported for `createDocument`'s default and for future migration code (no migration logic exists yet — nothing to migrate from).
- `Settings { solverMode: SolverMode; inputMultiplier: number; powerMultiplier: number; spaceElevatorMultiplier: number; snapMachines: boolean; gridMachine: Point; snapWaypoints: boolean; gridWaypoint: Point; numberFormats: NumberFormats; connectionStyle: ConnectionStyle }` — `SettingsSchema`. `SolverMode = 'none'|'manual'|'basic'|'full'` (`SolverModeSchema`), `ConnectionStyle = 'straight'|'step'|'smoothstep'|'bezier'` (`ConnectionStyleSchema`), `Point = { x: number; y: number }` (`PointSchema`), `NumberFormats = { style: 'fraction'|'mixed'|'decimal'; digits: number; rounding: 'round'|'floor'|'ceil'|'truncate'; trimTrailingZeros: boolean }` (`NumberFormatsSchema`) — this deliberately mirrors `@scm/rational`'s `formatRational` options (job 002) without importing `@scm/rational` (not a dependency of this package); reconcile the two in Job 019 if they've drifted.
- `Container { id; kind: ContainerKind; parentId: string | null; title: string; color: string; x: number; y: number; copiesLimit: number | null }` — `ContainerSchema`. `ContainerKind = 'root'|'outpost'|'blueprint'` (`ContainerKindSchema`).
- `NodeRecord { id; containerId; kind: string; recipe: string | null; machine: string | null; x; y; title; color; limit: string | null; limitMode: LimitMode; clock: string | null; autoRound: boolean; shards: number; purity: Purity | null; beltTier: string | null; storageMode: string | null; priorityOrder: string[] }` — `NodeRecordSchema`. `LimitMode = 'machines'|'ppm'` (`LimitModeSchema`), `Purity = 'impure'|'normal'|'pure'` (`PuritySchema`). `kind` is typed as a permissive `NodeKind = KnownNodeKind | (string & {})` (open union) rather than a closed enum — PLAN.md §4's own `proj_nodes` comment lists `'recipe' | 'splurger' | 'storage' | 'outpost' | ...` with an explicit ellipsis, and later phases (priority splitters/mergers, blueprint refs) add more kinds. `KNOWN_NODE_KINDS = ['recipe','splurger','storage','outpost'] as const` is exported for anyone who wants the currently-known set. **`limit`/`clock` are typed `string | null`** — PLAN.md §4 doesn't pin their on-the-wire type; per this job's brief, that decision is explicitly deferred to Job 010. `string` was chosen because it's the representation every other exact-value field in this system already uses (`game_data.json`'s `Amount`/`BatchTime`, Postgres's `limit_exact`/`clock_exact` projection columns) — treat it as a placeholder convention Job 010 can either keep or revisit, not a locked-in format.
- `EdgeRecord { id; containerId; part: string; fromNode; fromPort; toNode; toPort; waypoints: Waypoint[]; style: string | null; labelPos: number | null }` — `EdgeRecordSchema`. `Waypoint = Point` (`WaypointSchema`). `labelPos` is assumed to be a 0..1 t-parameter along the edge's path (not an `{x,y}` offset) — PLAN.md doesn't specify further; flag for Job 011 (connections & waypoints UI) to confirm/adjust when it builds the label-drag interaction.

### Document wrapper (`./document`)

- `SfmDocument { doc: Y.Doc; meta: Y.Map<unknown>; settings: Y.Map<unknown>; containers: Y.Map<Y.Map<unknown>>; nodes: Y.Map<Y.Map<unknown>>; edges: Y.Map<Y.Map<unknown>> }` — the raw `Y.Doc` and top-level maps are exposed **on purpose** (see Job 008 notes below), but nothing should hand-construct entries in `containers`/`nodes`/`edges` — always go through `mutations.ts`.
- `createDocument(options?: { doc?: Y.Doc; meta?: Partial<Meta>; settings?: Partial<Settings> }): SfmDocument` — creates a new `Y.Doc` (or wraps a supplied one, e.g. one just hydrated via `Y.applyUpdate`) and gets/creates the five top-level maps at their PLAN.md §4 keys. Only writes `meta`/`settings` defaults (merged with any `options.meta`/`options.settings` overrides) when those maps are still empty — safe to call repeatedly on the same doc without clobbering existing content.
- Reads: `getMeta(doc): Meta`, `getSettings(doc): Settings`, `getContainer(doc, id): Container | undefined`, `listContainers(doc): Container[]`, `getNode(doc, id): NodeRecord | undefined`, `listNodes(doc): NodeRecord[]`, `listNodesByContainer(doc, containerId): NodeRecord[]`, `getEdge(doc, id): EdgeRecord | undefined`, `listEdges(doc): EdgeRecord[]`, `listEdgesByContainer(doc, containerId): EdgeRecord[]`.
- Converters (also the right thing to call on a `Y.Map` you get from an `.observe()` event target): `containerToPlain(map): Container`, `nodeToPlain(map): NodeRecord`, `edgeToPlain(map): EdgeRecord`.
- `snapshotDocument(doc): DocumentSnapshot` (`{ meta, settings, containers: Container[], nodes: NodeRecord[], edges: EdgeRecord[] }`) — full plain-object snapshot, used by `validate.ts` and by tests; also a reasonable shape for a future solver-input adapter (Job 017/018) to build on.

### Mutations (`./mutations`)

Every function takes an `SfmDocument` and an optional trailing `origin?: unknown`; every function's body is a single `sfmDoc.doc.transact(fn, origin)` call (verified in tests via a `doc.on('update')` counter). Omitting `origin` produces Yjs's default local origin (`null`), which is what `createUndoManager` tracks by default.

- Containers: `addContainer(doc, input: NewContainerInput, origin?): Container` (`NewContainerInput = Omit<Container,'id'> & { id?: string }`; auto-generates `id` if omitted), `updateContainer(doc, id, patch: ContainerPatch, origin?): Container` (throws if `id` doesn't exist), `removeContainer(doc, id, origin?): void`.
- Nodes: `addNode(doc, input: NewNodeInput, origin?): NodeRecord` (`NewNodeInput = Omit<NodeRecord,'id'|'priorityOrder'> & { id?: string; priorityOrder?: string[] }`), `updateNode(doc, id, patch: NodePatch, origin?): NodeRecord` (patch excludes `priorityOrder`; throws if `id` doesn't exist), `moveNode(doc, id, x, y, origin?): NodeRecord` (thin sugar over `updateNode`), `setPriorityOrder(doc, id, order: string[], origin?): NodeRecord`, `removeNode(doc, id, origin?): void`.
- Edges: `addEdge(doc, input: NewEdgeInput, origin?): EdgeRecord` (`NewEdgeInput = Omit<EdgeRecord,'id'|'waypoints'> & { waypoints?: Waypoint[] }`) — computes `id` via `computeEdgeId(fromNode, fromPort, toNode, toPort)` and is **idempotent**: if that id already exists, the existing record is returned untouched (fields are not overwritten by the second call). This is deliberate — it's what makes two concurrent "same connection" drags converge to one entry without one clobbering the other's waypoints/style. `updateEdge(doc, id, patch: EdgePatch, origin?): EdgeRecord` (patch excludes `id`/`containerId`/endpoints/`waypoints` — reconnecting an edge to different ports means removing it and calling `addEdge` again, since the id is derived from the endpoints), `removeEdge(doc, id, origin?): void`, `addWaypoint(doc, edgeId, point: Waypoint, index?, origin?): EdgeRecord` (appends if `index` omitted), `removeWaypoint(doc, edgeId, index, origin?): EdgeRecord`, `updateWaypoint(doc, edgeId, index, patch: Partial<Waypoint>, origin?): EdgeRecord`.
- **Neither `removeNode` nor `removeContainer` cascades.** Dangling edges after a node delete, or orphaned children after a container delete, are left as-is — cleaning those up is explicitly the integrity reducer's job (PLAN.md §5, Job 022), not this layer's. Job 008-013's UI code should either call `removeEdge` itself for anything visibly connected, or accept that dangling refs are normal until Job 022 lands.

### Deterministic edge IDs (`./edgeId`)

`computeEdgeId(fromNode: string, fromPort: string, toNode: string, toPort: string): string`. Algorithm: join the four strings with a `U+0000` (NUL) separator (chosen because it can't appear in UI-generated IDs, so `fromNode="a", fromPort="b:c"` can never collide with `fromNode="a:b", fromPort="c"`), then run **two independent 32-bit FNV-1a passes** over that joined string with different offset bases (`0x811c9dc5` and `0x9e3779b9`), and concatenate the two results as 8-hex-char blocks into a `e_<16 hex chars>` (64-bit) id. FNV-1a was chosen over a heavier hash library per the job's own guidance to keep this "small, pure, heavily-tested" and dependency-light; doubling to 64 bits pushes the birthday-bound collision risk (a single 32-bit pass starts colliding around ~65k edges) well past any plausible factory size. **This hash is directional** — swapping `(fromNode,fromPort)` with `(toNode,toPort)` produces a different id, which matches the CRDT semantics (a connection has a direction) rather than treating A→B and B→A as the same edge.

Verified directly in `edgeId.test.ts` (determinism, per-component sensitivity, directionality, separator-collision guard) and end-to-end in `mutations.test.ts`'s `"deterministic edgeId"` test: two independent `addEdge` calls with an identical `(fromNode, fromPort, toNode, toPort)` tuple produce the same `id` and, applied to the same doc, leave `sfmDoc.edges.size === 1`.

### Undo manager (`./undo`)

- `INTEGRITY_ORIGIN = 'integrity' as const` — the reserved origin tag from PLAN.md §5 ("inside a Yjs transaction tagged `origin: 'integrity'` so it never pollutes anyone's undo stack"). **Job 022 should tag its repair transactions with this exact value** — either via `sfmDoc.doc.transact(fn, INTEGRITY_ORIGIN)` directly, or via the `runAsIntegrity(doc, fn): void` helper exported from this module, which does exactly that.
- `createUndoManager(doc: SfmDocument, options?: { trackedOrigins?: Set<unknown>; captureTimeout?: number }): Y.UndoManager` — scope is `[settings, containers, nodes, edges]` (deliberately **not** `meta`: schema/title/game-data-version bookkeeping isn't something users expect Ctrl+Z to touch from the canvas). `trackedOrigins` defaults to `new Set([null])` (Yjs's own default — only "plain" local transactions, which is what every mutation helper produces unless a caller passes an explicit `origin`).
- **How the integrity exclusion actually works, precisely, for Job 022 to rely on:** `createUndoManager` takes whatever `trackedOrigins` set it's given (default or caller-supplied) and unconditionally calls `.delete(INTEGRITY_ORIGIN)` on it before constructing the `Y.UndoManager`. This means (a) by default, `'integrity'`-tagged transactions were already excluded since they're simply not `null`, but (b) even if a future caller (e.g. Job 012's per-user undo, which will need to pass a custom `trackedOrigins` containing session/user ids) accidentally includes `'integrity'` in that set, it gets stripped before the `Y.UndoManager` is constructed. So Job 022's repair transactions are guaranteed to never land on the undo stack, and Job 012 doesn't need to remember to exclude `'integrity'` itself when it builds its own `trackedOrigins` set. Tested explicitly in `undo.test.ts`: after a tracked `addNode`, `undoManager.undoStack.length === 1`; after an `INTEGRITY_ORIGIN`-tagged `updateNode` (applied via `runAsIntegrity`), the doc reflects the change but `undoStack.length` is still `1` (not `2`); a third test proves this survives even when a caller's `trackedOrigins` explicitly (and wrongly) includes `INTEGRITY_ORIGIN`.
- Undo/redo semantics themselves are plain `Y.UndoManager` behavior (not reimplemented here): `.undo()`/`.redo()`, `.stopCapturing()` to force a new undo-stack boundary between logically-separate edits, `.undoStack`/`.redoStack` arrays whose `.length` is the natural thing to poll for enabling/disabling undo/redo UI, and the manager's own `stack-item-added`/`stack-item-popped`/`stack-cleared` events if Job 012 wants to react instead of poll.

### Validation (`./validate`)

- Per-record validators: `validateMeta`, `validateSettings`, `validateContainer`, `validateNodeRecord`, `validateEdgeRecord` — thin `.safeParse()` wrappers around the zod schemas from `schema.ts`, returning zod's own `SafeParseReturnType`.
- `validateDocumentSnapshot(snapshot: DocumentSnapshot): { valid: boolean; issues: DocumentIssue[] }` (`DocumentIssue = { path: string; message: string }`) — shape-validates every record in the snapshot *and* checks the referential-integrity invariants PLAN.md §5 names for the integrity reducer to eventually repair: container `parentId` must reference an existing container, node `containerId` must reference an existing container, edge `containerId`/`fromNode`/`toNode` must reference existing records. Collects every issue rather than short-circuiting on the first one, since Job 022's reducer will want the full list to repair in one pass. **This module only detects — it never repairs or mutates.** Repairing (delete dangling edges, reparent orphaned nodes to root, clamp shards, dedupe edges) is entirely Job 022's scope; this is just the detector it can build on.

### What Job 008 (canvas skeleton) needs to know

- **Observing changes:** call `.observe(callback)` on `sfmDoc.containers`/`sfmDoc.nodes`/`sfmDoc.edges` (top-level `Y.Map<Y.Map<unknown>>`, exposed directly on the `SfmDocument`) to react to key-level add/delete/update, or `.observeDeep(callback)` on the same maps to also catch field-level changes inside individual node/edge/container `Y.Map`s (e.g. someone else's `updateNode` call). `.observe(callback)` on `sfmDoc.meta`/`sfmDoc.settings` works the same way for those two. Every observe callback receives Yjs's own `YMapEvent`/`YEvent[]`; when you need the *current* typed value of a changed record, don't read fields off the event's `target` by hand — pass it to `nodeToPlain`/`edgeToPlain`/`containerToPlain` (or call `getNode`/`getEdge`/`getContainer` again by id) to stay inside this package's typed-access discipline.
- **Do not construct or mutate `Y.Map`/`Y.Array` entries directly** even from `apps/web` code that has a reference to `sfmDoc.nodes` etc. for observation purposes — always go through `mutations.ts`'s helpers to write.
- **Undo manager:** build one with `createUndoManager(sfmDoc)` once per open document (not per component) and wire `.undo()`/`.redo()` to keyboard shortcuts; see the `./undo` notes above for how to read stack state for UI enabling.
- **IDs:** node/container ids from `addNode`/`addContainer` are Web-Crypto UUIDs prefixed `n_`/`c_` when the environment has `crypto.randomUUID` (true in both browsers and Node ≥19), with a `Math.random()`-based fallback otherwise — don't assume a particular id format beyond "opaque string," and don't try to parse them.
- **Nothing has been wired into React Flow or Zustand** — that integration, including deciding whether the Zustand store mirrors doc state or the canvas reads straight from Yjs via observers, is entirely Job 008's design space.

### Package/build setup

- `packages/ydoc/package.json`: added `dependencies: { yjs: "13.6.32", zod: "4.4.3" }` (yjs's first use anywhere in the repo — pinned to the current latest stable, matching the exact-pin style `gamedata` already uses for `zod`) and `devDependencies.vitest: "^4.1.10"` (matching `rational`/`gamedata`), plus a `"test": "vitest run"` script. `build` now points at a new `tsconfig.build.json` (extends `tsconfig.json`, excludes `src/**/*.test.ts`) — same pattern `rational`/`gamedata` established, so compiled test files don't leak into `dist/`.
- One typecheck-only wrinkle: `Y.AbstractType<T>` is invariant over `T` in its internal `_eH` event-handler field, so an array of `Y.Map<unknown>`/`Y.Map<Y.Map<unknown>>` doesn't structurally satisfy `Y.AbstractType<unknown>[]` even though it's exactly what `Y.UndoManager`'s `scope` constructor argument expects at runtime. `undo.ts`'s `createUndoManager` has a documented `as unknown as Array<Y.AbstractType<unknown>>` cast for this — a known/expected Yjs typing gap, not a bug.

**Verification actually run, all clean:**
- `pnpm --filter @scm/ydoc test` — 5 files, 25 tests passed (edgeId, document, mutations, undo, validate).
- `pnpm --filter @scm/ydoc build` — clean; `tsconfig.build.json` keeps `dist/` free of compiled test files.
- `pnpm --filter @scm/ydoc typecheck` — clean.
- `pnpm -r build` and `pnpm -r typecheck` — clean across all 9 buildable workspaces (`apps/web`, `apps/api`, `apps/realtime`, `db`, and all 5 packages).
- `pnpm -r test` excluding `apps/api`: clean (`rational` 67 tests, `gamedata` 40 tests, `ydoc` 25 tests, all passing). `apps/api`'s own test suite fails in this environment with `password authentication failed for user "scm"` / connection resets — that's a missing local Postgres instance (this job's track never touches `apps/api`; confirmed via `git status` that no `apps/api` file was modified), not a regression from this change.
- `pnpm lint` (root flat ESLint config) — clean, no new rules needed, exit code 0.

**Deviations from the spec / things flagged for later jobs:**
- The job file's deliverables list `mutations.ts` with `addNode, updateNode, removeNode, addEdge, removeEdge, addContainer, removeContainer, moveNode, addWaypoint, removeWaypoint, etc.` — the "etc." was filled in with `updateContainer`, `setPriorityOrder`, `updateEdge`, and `updateWaypoint`, since the node/edge field lists (`priorityOrder`, edge `style`/`labelPos`/`part`) need *some* way to be written and it seemed better to provide one now than have Job 010/011 reach past this package's discipline to do it by hand.
- `limit`/`clock` (`NodeRecord`) typed as `string | null` and `labelPos` (`EdgeRecord`) assumed to be a 0..1 t-parameter — both are documented above as placeholder conventions for Job 010/011 to confirm or override, per this job's explicit instruction not to guess ahead on the exact on-the-wire numeric representation.
- `storageMode`/`beltTier` (`NodeRecord`) and `copiesLimit` (`Container`) are typed loosely (`string | null`, `string | null`, `number | null`) since PLAN.md §4 names them but their concrete value sets aren't specified anywhere yet (storage node UI and belt-tier data aren't built until later jobs) — flag for whichever job first gives them real UI to confirm/tighten the type.
- No schema-migration logic exists yet (nothing to migrate from — this is the first schema version), but `CURRENT_SCHEMA_VERSION` and `meta.schemaVersion` are in place for whenever that's needed.
