# Job 016: IndexedDB cache, autosave indicator & version restore

**Phase:** 3 · Persistence
**Status:** Done
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

## Handoff notes

### File locations

- `apps/web/src/canvas/persistence/useProjectDocument.ts` — rewritten (not just extended) to add the IndexedDB cache lifecycle and `SaveStatus`/`reloadAfterRestore`. The Job 015 hydration-ordering invariant (push-listener-before-root-creation) is preserved and documented in-line — see "IndexedDB integration" below for exactly how the fast path interacts with it.
- `apps/web/src/canvas/persistence/updateQueue.ts` — gained `SaveStatus`, `onStatusChange`, `getStatus()`, and an auto-retry-on-failure loop. Existing `enqueue`/`flushNow`/`dispose` behavior unchanged.
- `apps/web/src/canvas/persistence/docApi.ts` — added `listProjectVersions`, `saveProjectVersion`, `restoreProjectVersion` (client-side REST wrappers), alongside the existing `fetchProjectDoc`/`pushProjectDocUpdate`.
- `apps/web/src/canvas/persistence/SaveStatusIndicator.tsx` (new) — the "Saved"/"Saving…"/"Offline — reconnecting"/"View only" pill.
- `apps/web/src/canvas/persistence/VersionPanel.tsx` (new) — the version list + save/restore dropdown (styled like `SettingsMenu.tsx`).
- `apps/web/src/canvas/CanvasView.tsx` — threads `projectId`/`role`/`saveStatus`/`onRestored` into `CanvasViewReady`, replaces the old static autosave footer text with `<VersionPanel>` + `<SaveStatusIndicator>`.
- `apps/web/src/canvas/index.ts` — barrel gained the new version-API exports, `SaveStatus`, `SaveStatusIndicator`, `VersionPanel`.
- `apps/api/src/projects/docStorage.ts` — added `ProjectVersionSummary`/`ProjectVersionKind`, `listProjectVersions`, `getProjectVersionBytes`, `restoreProjectVersion`; `createProjectVersion` now returns the inserted row's metadata instead of `void`; `appendUpdate` now creates an `'auto'` version snapshot whenever a threshold-triggered compaction actually folds rows.
- `apps/api/src/projects/docRoutes.ts` — three new routes: `GET/POST /api/projects/:id/versions`, `POST /api/projects/:id/versions/:versionId/restore`.
- `apps/web/package.json` — added `y-indexeddb` (`^9.0.12`).

### IndexedDB integration — the fast path, and a real bug this job hit and fixed mid-work

`useProjectDocument`'s `load()` now does, in order:
1. `doc = new Y.Doc()`, then `new IndexeddbPersistence(indexedDbName(projectId), doc)` and `await idb.whenSynced` — this applies whatever's already cached locally (nothing, on a first-ever visit) into `doc`, with the library's own origin (never mistaken for a local edit worth pushing — see the `RECONCILE_ORIGIN` sentinel below).
2. **Fast path check**: `hasRootContainer(doc)` — a pure, non-mutating read of `doc.getMap('containers')`. If the cache already has a root container (this device has opened this project before), `finishHydration()` runs *immediately* — the canvas renders now, before the network fetch even starts.
3. `fetchProjectDoc(projectId)` runs regardless (even on the fast path) — this is the reconciliation step. Its bytes are applied via `Y.applyUpdate(doc, bytes, RECONCILE_ORIGIN)` — tagged with a module-level `Symbol` origin so the push-queue listener (attached in `finishHydration`) never mistakes "content the server just sent us" for "a local edit worth pushing back." If the fetch fails and the fast path already rendered, this is non-fatal — the canvas stays up (see the code's own comment on why there's nothing further to do here).
4. `finishHydration()` runs again (no-op via a `hydrated` flag if the fast path already ran) — this is where the push queue gets wired, `createDocument`/root-ensuring happens, and `Y.UndoManager` is created **last**, exactly preserving Job 015's critical ordering invariant. A brand-new project (empty cache *and* empty server) never takes the fast path (`hasRootContainer` is false), so it falls through to exactly Job 015's original network-required behavior — the invariant is never at risk for the one case it actually protects (a fresh project's very first `addContainer`).

**A real bug found via manual browser verification, not caught by any automated test** (`useProjectDocument.ts` isn't unit-tested — same pre-existing gap Job 015 flagged): the first draft used a "bump a generation counter and rename the IndexedDB database" scheme to invalidate the local cache after a restore (to stop the fast path from resurrecting pre-restore content). The counter lived in a `useRef`. That works *within* one browser session, but a `useRef` resets to its initial value on every remount — **including a real page reload**, which is exactly what "reloading shows the cached local state instantly" is supposed to exercise. After a restore, the *next actual reload* silently fell back to generation 0's name — a long-stale, pre-restore (or even genuinely empty) database — and the fast path either showed stale content or, worse, didn't fire at all (observed live: a project that had real cached content showed the "Loading project…" screen for the full duration of an artificially-slowed network fetch, instead of rendering instantly). Fixed by dropping the generation scheme entirely: one fixed IndexedDB database name per project, forever. On restore (`reloadAfterRestore`), the *current* `IndexeddbPersistence` connection is closed deterministically (`await idbRef.current?.destroy()`) and *then* its database is deleted (`await clearDocument(name)`) — sequencing matters, since `indexedDB.deleteDatabase` on a database with an open connection can hang waiting for it to close. Only after both complete does `retryToken` bump, re-running the effect against the same (now genuinely empty) name. This is the one place in this file where `reloadAfterRestore` deliberately does *not* mirror the effect cleanup's fire-and-forget `idb.destroy()` — it's awaited, because the delete that follows depends on it actually finishing first.

Degrades gracefully if IndexedDB itself is unavailable (private browsing in some browsers, quota errors): `idb.whenSynced` is wrapped in try/catch, falling through to network-only behavior with a `console.warn`, not a failed load.

### Autosave-indicator state machine

`updateQueue.ts`'s `SaveStatus = "saved" | "saving" | "offline"`, computed internally (`computeStatus()`) and pushed out via an `onStatusChange` callback plus a synchronous `getStatus()` getter:
- **`"saving"`**: something is enqueued — covers both "waiting out the debounce timer" and "the POST is actually in flight." Entered the moment `enqueue()` is called.
- **`"offline"`**: the most recent flush attempt failed. **Sticky** — takes precedence over `"saving"` even while `pending.length > 0` during a retry wait, so the indicator doesn't flicker between the two on every retry attempt.
- **`"saved"`**: nothing pending, nothing in flight, no unresolved failure.

**A gap in Job 015's original queue, fixed here**: the original queue only ever rescheduled a flush from `enqueue()` — a failed push with nothing further typed would sit forever unless the user happened to make another edit. That would make "Offline — reconnecting" a lie (nothing was actually reconnecting). Fixed by calling `scheduleFlush()` again from inside the `catch` branch, so a failure now retries automatically every `delayMs` (same cadence as the debounce, no separate backoff schedule) until it succeeds or `dispose()` is called. Verified live: killed the `apps/api` dev process mid-session, made an edit (indicator → "Offline — reconnecting"), restarted the API, and the indicator recovered to "Saved" on its own with **no further user action** — the queue's own retry loop did it.

`useProjectDocument` wires `onStatusChange` straight to a `saveStatus` React state, exposed alongside the existing `ProjectDocumentState` union rather than folded into it (a separate `useState`, merged into the returned object only for the `"ready"` case) — this avoids re-triggering the whole `status: "loading"|"error"|"ready"` state machine on every save-status tick, which only `CanvasViewReady` needs to react to.

`SaveStatusIndicator.tsx` renders a dot + label for owner/editor, and a distinct **"View only"** label for `role === "viewer"` — a viewer's push queue is never wired at all (Job 015's own gating), so showing "Saved" for a viewer would be actively misleading (their local edits never persist — see Job 015's handoff notes on this still-open UX gap, unchanged by this job).

### Version list/restore API surface

Server (`docStorage.ts`, transport-agnostic as established by Job 015):
- `createProjectVersion(projectId, { label?, kind, createdBy? })` → now returns `ProjectVersionSummary` (was `void`). Called from three places: `docRoutes.ts`'s manual-save route (`kind: 'manual'`), `appendUpdate` after a threshold-triggered compaction actually folds rows (`kind: 'auto'` — piggybacked on the existing compaction cadence rather than a separate timer/cron, per the job file's own "every compaction" suggestion), and `restoreProjectVersion` (`kind: 'pre_restore'`).
- `listProjectVersions(projectId)` → `ProjectVersionSummary[]`, newest first, **no `ydoc` bytes** (list-only, keeps the response small).
- `getProjectVersionBytes(projectId, versionId)` → `Uint8Array | null`, scoped by `projectId` so a version id from a different project can never be read cross-project.
- `restoreProjectVersion(projectId, versionId, actorUserId)` → `RestoreResult | null` (`null` if the version doesn't belong to this project). See "wholesale replace" below for the mechanism.

Routes (`docRoutes.ts`, same auth/role pattern as the existing doc routes):
- `GET /api/projects/:id/versions` — any member (owner/editor/viewer).
- `POST /api/projects/:id/versions` (body: `{ label?: string }`) — owner/editor only, 403 for a viewer.
- `POST /api/projects/:id/versions/:versionId/restore` — owner/editor only, 403 for a viewer, 404 for a version id that doesn't belong to the project.

Client (`docApi.ts`): `listProjectVersions`, `saveProjectVersion(projectId, label?)`, `restoreProjectVersion(projectId, versionId)` — thin fetch wrappers matching the existing `fetchProjectDoc`/`pushProjectDocUpdate` conventions.

UI (`VersionPanel.tsx`): a `SettingsMenu.tsx`-styled dropdown (not a modal) — label input + "Save version" button (owner/editor only), a scrollable list (timestamp, label-or-"(unlabeled)", kind badge), and a "Restore" button per row (owner/editor only) gated behind `window.confirm`. Deliberately no diffing/rich history browsing, per the job file's own scope note.

### The "wholesale replace, not merge" restore mechanism

Both server and client independently need "the restored version becomes current" to be unambiguous, not a CRDT merge — for two different reasons:

**Server** (`docStorage.ts`'s `restoreProjectVersion`): if restoring just `Y.applyUpdate`-d the version's bytes into the *current* live snapshot+log, this would be a genuine Yjs merge — two independent write histories combining, not a rollback. A node deleted in the current (about-to-be-overwritten) state but present in the restored version would silently reappear *alongside* the current state's other content, a union, not a replacement. Fixed by building a **fresh `Y.Doc`**, applying *only* the restored version's bytes to it, and writing that as the new `project_doc_state` snapshot — inside a transaction that also discards (not folds) every existing `project_doc_updates` row, by setting the new snapshot's `seq` to the highest existing log id (so `loadProjectDoc`'s `id > seq` filter naturally excludes all of them) and deleting them. The `pre_restore` safety snapshot is taken *before* this transaction, from the current merged state — so restoring is itself non-destructive at the version-history level.

**Client** (`useProjectDocument.ts`'s `reloadAfterRestore`): even if the server-side replace is correct, the client's *own* live `doc` still has the pre-restore content in memory — `Y.applyUpdate`-ing the restored bytes into that live doc would have exactly the same "union, not replacement" problem locally. Fixed by forcing a full re-hydration (new `Y.Doc`, cleared IndexedDB cache, fresh network fetch) rather than trying to reconcile in place — see "IndexedDB integration" above.

**Verified end-to-end in a real, non-bypassed browser session** (see "Manual verification performed" below): state A → save version → state B → restore → canvas shows state A again (confirmed via `window.__sfmDoc.nodes` node-id set, not just visually) → the pre_restore snapshot of B is in the version list → restoring *that* pre_restore snapshot brings back exactly state B's node set. Round-trips correctly in both directions.

### Manual verification performed

Through the real (non-bypassed) session-cookie auth flow, per this job's own guidance and Job 015's precedent — minted a real `users`+`sessions` row via `auth/session.ts`'s `createSession()` (throwaway `pathToFileURL`-wrapped script), set the raw token as `document.cookie`, drove the real `App.tsx` shell:
- **Instant cache render**: opened a project once (populating its IndexedDB cache), then reloaded the page and re-opened it with an artificial 4-second delay injected into `fetchProjectDoc` (temporarily edited into `docApi.ts`, reverted before committing — confirmed via `git diff` afterward that no trace of it remains). The canvas rendered its cached content (both nodes) in the very next screenshot after the click, well under the 4-second delay — no blank/loading flash. After the delay elapsed, the node count was unchanged (2), confirming the network reconciliation didn't duplicate or corrupt anything.
- **Autosave indicator**: observed "Saved" at rest, "Offline — reconnecting" within ~2s of killing the `apps/api` process and making an edit, and automatic recovery to "Saved" after restarting the API — with no further user interaction, confirming the queue's own auto-retry loop (not just `onError` firing once).
- **Version restore round-trip**: built state A (1 node) → saved a "State A" manual version → added a second node (state B) → restored "State A" → canvas showed exactly the original state-A node id (verified via `window.__sfmDoc.nodes` keys, not just node count) → version list showed a new `pre_restore` snapshot of state B → restored that pre_restore snapshot → canvas showed exactly state B's two original node ids again. Both directions verified byte-identically-by-id, not just by count.
- **Viewer role**: a second user added as `viewer` sees "View only" (not "Saved"), can open the version list (read-only — no label input, no "Save version" button, no "Restore" buttons), matching the server-side 403 enforcement already covered by automated tests.
- **One environment quirk hit, not a product bug**: this sandboxed browser automatically suppresses native `window.confirm()` dialogs (auto-returns `false`), so `VersionPanel`'s restore confirmation had to be exercised by temporarily monkey-patching `window.confirm = () => true` via the JS console before clicking — a browser-automation limitation (similar in spirit to Job 015's own noted synthetic-event quirks), not something to "fix" in the app.

### Docker/Postgres status

Docker Postgres (`infra-postgres-1`, port 5434, per Job 015's port-5432-conflict workaround — still applicable, still the same native-Windows-Postgres conflict) was already running and migrated when this job started; used as-is (`DATABASE_URL="postgresql://scm:scm@localhost:5434/scm"` passed explicitly to every migrate/test/dev command, `infra/.env` left untouched). Left running for whoever picks up Job 017, containing this job's QA data (a few throwaway projects/versions) plus everything the automated test suites inserted against it — none of it meaningful, safe to `pnpm db:reset` or tear down and bring up fresh with the same `POSTGRES_PORT=5434` override.

### Test counts

`apps/api`: 67 → 92 (25 new — `docStorage.test.ts` +11, `docRoutes.test.ts` +14). `apps/web`: 169 → 172 (+3, all in `updateQueue.test.ts` — `SaveStatus`/auto-retry coverage; `useProjectDocument.ts` remains untested for the same pre-existing reason Job 015 flagged, see below). Repo-wide: rational 67, ydoc 29, gamedata 40, api 92, web 172 = **400 tests, all passing**. `pnpm --filter api --filter web test/build/typecheck`, `pnpm -r build/typecheck/test`, `pnpm lint` all clean.

### Deviations from the spec / things flagged for later jobs

- **Auto-version cadence is "every compaction," not a separate timer** — the job file explicitly left this to judgement ("e.g. every N minutes of activity, or every compaction"). Piggybacking on the existing ~200-row compaction threshold avoids adding a second background mechanism; a project with very light editing could go a long time between auto-versions, which seems acceptable for a "functional minimum" — a future polish pass (or Job 020's realtime work) could add a genuine time-based cadence if that turns out to matter in practice.
- **`useProjectDocument.ts` still has no automated test of its own** — same standing gap Job 015 flagged (`apps/web`'s Vitest config is node-environment-only, no React DOM testing). This job's own IndexedDB-cache bug (see above) was caught by manual browser verification, *not* by any test — a real illustration of the risk that gap represents. If a future job adds React Testing Library / a DOM environment to `apps/web`, `useProjectDocument.ts`'s hydration-ordering invariant and the fast-path/reconcile-origin logic in this job would be the highest-value first things to cover.
- **`window.confirm` for the restore confirmation** — matches `ProjectsPage.tsx`'s existing delete-confirmation pattern (Job 006), not a new UI convention. Fine for now; a future polish pass replacing native `confirm()`/`alert()` with in-app modals (if that ever happens) should catch this call site too.
- **Nothing here matters to Job 017 (solver core)** — confirmed by reading that job's file: it depends only on `packages/rational` (Job 002) and is explicitly pure logic with "no Yjs import, no DOM," independent of the canvas/persistence track entirely. Phase 4 can start with no knowledge of this job's internals.
- **Job 020 (Hocuspocus)'s own scope note is still accurate**: viewer read-only enforcement is still only server-side (403 on write routes) plus a client-side UI label (`SaveStatusIndicator`'s "View only" / gated `VersionPanel` buttons) — a viewer can still locally mutate the in-memory doc with no UI stopping them, same gap Job 015 flagged. This job's `VersionPanel` follows the same pattern (buttons hidden, not disabled-with-explanation) rather than closing that gap, since Job 020 is explicitly where it's meant to be closed for real.
