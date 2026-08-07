# Job 025: Relational projection (proj_nodes / proj_edges)

**Phase:** 6 · Full calculator
**Status:** Done
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

## Handoff notes

**Job 025 is done. This completes Phase 6 (Full calculator)** — PLAN.md §8's exit criteria for Phase 6 ("Full-mode results match the desktop tool on a shared benchmark set" plus, per this job, the relational projection existing) are now all met. Phase 7 (Polish & deploy) starts at Job 026 (Blueprints).

### Files

- `db/migrations/0009_proj_nodes.ts`, `db/migrations/0010_proj_edges.ts` — the two new tables, Kysely schema-builder style matching every prior migration (composite primary key via `addPrimaryKeyConstraint`, same pattern as `0004_project_members.ts`).
- `db/schema.ts` — `ProjNodesTable`/`ProjEdgesTable` (+ `ProjNode`/`NewProjNode`/`ProjNodeUpdate` and the edge equivalents) added to `Database`, matching every other table's `Selectable`/`Insertable`/`Updateable` convention.
- `packages/doc-storage/src/projection.ts` (new) — the whole materialization module: `deriveApprox`, `toProjNodeRow`, `toProjEdgeRow`, `materializeProjection`. Read its header comment first — it carries the full "why" for the hook point, the full-replace strategy, rational storage, and the machine-name copy-through decision; this section summarizes rather than repeats it.
- `packages/doc-storage/src/projection.test.ts` (new) — 33 tests total in the package (was 24 before this job — `docStorage.test.ts`'s existing count plus this file's new ones), all against the real Postgres instance, same precedent as `docStorage.test.ts`.
- `packages/doc-storage/src/docStorage.ts` — `appendUpdate` now calls `materializeProjection(projectId)` in a best-effort `try/catch` right after its own insert, before the existing compaction check. One new import line, one new `try/catch` block; the rest of the file (including every existing exported function's signature) is untouched.
- `packages/doc-storage/src/index.ts` — re-exports `./projection.js`.
- `packages/doc-storage/package.json` — added `@scm/rational` and `@scm/ydoc` as real (production) dependencies, and `@scm/gamedata` as a **devDependency only** (used by `projection.test.ts` to build a realistic MultiMachine fixture; production `projection.ts` never imports it — see below).

### Where the debounce/trigger hook lives, and why

Hooked inside `packages/doc-storage/src/docStorage.ts`'s `appendUpdate` — **not** inside `apps/realtime/src/server.ts`'s `onStoreDocument` directly. `appendUpdate` is the one function every doc-mutation call site goes through today regardless of transport (Hocuspocus's `onStoreDocument`, which is how virtually all real edits get persisted per Job 020, *and* the older REST push route in `apps/api`, still present though client-unused since Job 020). Hooking the shared function means materialization automatically covers every current and future caller with zero risk of a later job adding a new persistence call site that forgets to also trigger the projection — the same reasoning Job 020 itself used to justify promoting `appendUpdate` into this shared package in the first place. This rides Hocuspocus's own `debounce`/`maxDebounce` (or the REST route's own debounce) for free; no new timer, poll loop, or cron was added anywhere.

Materialization failure inside `appendUpdate` is caught and logged, never thrown — by the time it would run, the actual source of truth (the Yjs update) is already durably in `project_doc_updates`. A missed materialization just leaves the projection stale until the next successful flush, consistent with it being an explicitly read-only, best-effort cache.

### Rational storage — exactly what happens

`NodeRecord.limit`/`.clock` are already `@scm/rational` canonical `"n/d"` strings (or `null`) as of Job 010 (confirmed by reading `packages/ydoc/src/mutations.ts`'s `addNode` and Job 010's own Handoff notes — no reformatting happens anywhere in the write path). So:
- `limit_exact`/`clock_exact` = a straight, unmodified copy of `NodeRecord.limit`/`.clock`.
- `limit_approx`/`clock_approx` = `deriveApprox(exact)`, which is `toApproximateNumber(parseRational(exact))` — i.e. routed through `@scm/rational`'s own single deliberate float boundary (`power.ts`'s `toApproximateNumber`), never `Number(fractionString)` or any other independent computation. This is the literal, auditable mechanism behind PLAN.md's "never compute from the approximate column" rule.
- **One deliberate deviation from PLAN.md §4's literal sample SQL**: PLAN.md's own `proj_nodes` DDL sample lists `clock_exact` but not `clock_approx`. I added `clock_approx double precision` anyway — treating its absence as an inconsistency in the sample rather than an intentional asymmetry, since the same section's prose ("limit_exact/clock_exact... limit_approx/clock_approx...") and this job's own acceptance criteria ("limit_approx/clock_approx values...") both clearly expect it to exist. Flagging this explicitly in case a later job or reviewer expected byte-for-byte fidelity to PLAN.md's sample SQL specifically.

### MultiMachine resolution into `machine_name` — no `@scm/gamedata` call needed in production

Confirmed by reading `apps/web/src/panels/recipeChooser/filters.ts`'s `buildNodeInputForRecipe` (Job 009/010): a MultiMachine recipe is resolved via `@scm/gamedata`'s `resolveMachine`/`findVariant`/`defaultVariant` **once, at node-creation time**, and the resolved concrete variant's own `Machine.name` (e.g. `"Miner Mk.2"`) is what gets written to `NodeRecord.machine` — never the family name (`"Miner"`). So `toProjNodeRow` copies `node.machine`/`node.purity` straight through with zero re-resolution. This is why `projection.ts` has no `@scm/gamedata` production dependency at all — only `projection.test.ts` uses it (as a devDependency), to build a genuine "Miner Mk.2 on Pure" fixture via the real `defaultGameData` + `resolveMachine` + `findVariant`, mirroring exactly what the real Recipe Chooser does, rather than hand-typing the resolved string and only proving the copy-through in isolation.

### Cleanup mechanism (no stale rows)

Full replace-on-materialize: every call to `materializeProjection(projectId)` deletes **all** existing `proj_nodes`/`proj_edges` rows for that project, then bulk-inserts exactly the current `listNodes(sfmDoc)`/`listEdges(sfmDoc)` set, inside one `db.transaction()` (so a concurrent reader never observes a torn, all-deleted state). At PLAN.md §2's stated scale ("tens to low hundreds per outpost") this is simpler and provably correct — there's no "did I remember to delete this node's row" bookkeeping that a diff-based upsert+delete would need. Verified directly: `projection.test.ts` has explicit node-deletion and edge-deletion tests, each asserting the row count drops to zero after the next `appendUpdate`/materialization following a `removeNode`/`removeEdge` call.

### Two real bugs found and fixed in this job's own test harness (not production bugs — flagging so a future job doesn't waste time rediscovering these)

1. **A Yjs diff-vs-baseline trap.** My first test harness captured a `Y.Doc`'s "prior state vector" *after* `createDocument()` had already run its own `doc.transact()` calls to populate default `meta`/`settings`, then sent only the *subsequent* diff to `appendUpdate`. Every materialization silently produced zero rows. Root cause (isolated with a series of minimal raw-Yjs repros, see this job's own session — not left in the repo): `Y.encodeStateAsUpdate(doc, vector)` is a genuine incremental *diff*, only valid to apply on top of the exact baseline `vector` describes; a receiver (a fresh `Y.Doc` built by `loadProjectDoc`) that never received the omitted earlier content has a causal gap for that client id, and Yjs *silently* buffers/drops the un-integrable struct instead of throwing. This is correct, documented Yjs behavior, not a library bug — but it's an easy trap for any test harness (or, in principle, any real client code) that manually slices `encodeStateAsUpdate` calls across a boundary it didn't also persist. Fixed by capturing the state vector before `createDocument()` runs (see `createDocEditor()` in `projection.test.ts`). **Worth double-checking**: `apps/web`'s real client persistence path only ever calls `doc.on('update', ...)` per-transaction (Yjs's own event, always correctly incremental relative to what was already applied) rather than manually managing a state vector across multiple transactions the way my test harness did — so this specific trap should not be reachable in production, but it's exactly the kind of pattern worth a second look if any future job (e.g. an import/migration script) ever manually drives `encodeStateAsUpdate`/`encodeStateVector` directly.
2. **`proj_edges.waypoints` (a real `jsonb` column) reads back as a raw JSON *string*, not an auto-parsed value**, through this app's specific `Kysely` + `kysely-postgres-js` + `postgres.js` stack. Verified empirically against a throwaway real table (not just this job's own code): `postgres.js`'s default type parsers *do* correctly auto-parse jsonb for its own tagged-template queries, but `kysely-postgres-js`'s `PostgresJSConnection.executeQuery` drives every query via `postgres.js`'s `.unsafe(sql, params)` method — and a parameterized `.unsafe()` call, even selecting a genuine `jsonb`-typed table column, comes back as unparsed text. This is the **first jsonb column in this entire codebase that anything ever reads back structurally** (the pre-existing `projects.doc_settings` jsonb column is only ever copied verbatim between rows, never destructured) — so this is a previously-latent, now-documented quirk of the stack, not something Job 025 introduced. `projection.test.ts` accounts for it (`JSON.parse(row.waypoints as string)`); **any future code that reads `proj_edges.waypoints` (or any other jsonb column, through this same driver stack) must `JSON.parse` it explicitly.**

### Verification performed

- `pnpm --filter @scm/doc-storage build`/`typecheck`/`test` — clean, 33/33 tests (was 24 before this job).
- `pnpm --filter api build`/`typecheck`/`test` — clean, 100/100 (untouched by this job; confirms the shared package's expanded dependency surface didn't regress `apps/api`).
- `pnpm -r build`/`typecheck` — clean across all 10 workspaces.
- `pnpm -r test` — one `apps/realtime` test (`server.test.ts`, a 5000ms WebSocket-convergence timeout) failed under full concurrent repo-wide load. **Confirmed via `git stash` that this same failure (a different specific test each run, always in `server.test.ts`, always a 5000ms timeout) reproduces identically on the pre-Job-025 baseline code** — i.e. this is pre-existing resource-contention flakiness in this sandbox when `apps/api` and `apps/realtime`'s real-Postgres/real-WebSocket suites run concurrently with everything else, not a regression from this job's added per-persist DB work. Matches the same class of flakiness Jobs 017/018/022/023/024 already documented. Running `apps/realtime`'s suite alone (twice) passed 15/15 both times.
- `pnpm lint` — clean.
- Migrations applied against the real running Postgres (`infra/.env`'s `DATABASE_URL`, port 5434) via `pnpm db:migrate` — both `0009_proj_nodes`/`0010_proj_edges` applied successfully; `proj_nodes`/`proj_edges` now exist as real tables.
- Acceptance-criteria-specific checks, all covered by real tests in `projection.test.ts` against the real Postgres instance (not mocked): a genuine Miner Mk.2/Pure node (built via `@scm/gamedata`'s real `resolveMachine`/`findVariant` against `defaultGameData`, mirroring the real Recipe Chooser) materializes with `machine_name: "Miner Mk.2"`, `purity: "pure"`, and the exact `limit_exact` fraction string; `limit_approx`/`clock_approx` are asserted to equal (not just "close to") `toApproximateNumber(parseRational(exact))` recomputed independently in the test, and separately round-tripped through `parseRational` back to the original value; node deletion and edge deletion each drop the corresponding row count to zero on the next materialization; a repo-wide grep (`grep -rln "proj_nodes\|proj_edges\|ProjNode\|ProjEdge"`) confirms these identifiers appear **only** inside `packages/doc-storage/{dist,src}` — zero occurrences anywhere in `apps/api`, `apps/web`, or any other package, confirming no client-facing route has any read or write access to these tables.

### For Job 026 (Blueprints) — the PLAN.md §10.3 open question

PLAN.md §10.3 asks whether a blueprint's copy count should participate in the same solve or be a post-multiply. This job's projection work doesn't resolve that question (it's a solver/CRDT-schema decision, out of this job's scope), but two things worth knowing:
- `proj_nodes`/`proj_edges` are strictly **derived from and downstream of** whatever `@scm/ydoc`/`@scm/solver` end up representing — nothing here needs to change based on which way that question is resolved, *except* that if Job 026 adds any new `NodeRecord`/`EdgeRecord` fields (e.g. a blueprint copy-count field, or per-instance overrides), those won't automatically appear as `proj_nodes`/`proj_edges` columns — PLAN.md §4's sample DDL doesn't list one, and this job didn't speculatively add one (same "add only what's demonstrably needed" judgement applied to the `clock_approx` addition above, just in the other direction). A future job should extend the migrations/`toProjNodeRow` if/when a real column is needed for search/gallery/analytics over blueprint copy counts specifically.
- Container `kind: "blueprint"` (Job 007's schema, already defined) has no representation in `proj_nodes` at all today — `proj_nodes` only ever reflects `nodes`, not `containers`. If Job 026 (or a later phase) wants blueprints queryable via this projection (e.g. "which projects use blueprints"), that would need a new column/table this job did not anticipate, since PLAN.md §4's `proj_nodes`/`proj_edges` schema has no container-level fields beyond `container_id` as a foreign-key-shaped string.
