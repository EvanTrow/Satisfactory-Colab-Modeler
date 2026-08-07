# Job 006: Project list UI + project CRUD

**Phase:** 1 · Auth & projects
**Status:** Done
**Depends on:** 005 (Discord OAuth2 — needs a logged-in user to own projects)

## Context

Read [`PLAN.md`](../PLAN.md) section **3. Feature Scope → MVP → Platform** (project list: create/rename/duplicate/soft-delete) and section **4. Data Model → Identity, projects, sharing** (the `projects` table, especially `short_id`, `visibility`, `deleted_at` soft-delete). This is the last Phase-1 job — after this, Phase 2 starts building the actual canvas.

## Scope

In scope:

- `apps/api` REST routes (authenticated, using the session middleware from Job 005):
  - `POST /api/projects` — create, defaults `title` to `'My Factory'`, generates a unique URL-friendly `short_id`, sets `owner_id` to the current user, and inserts an `owner` row into `project_members`.
  - `GET /api/projects` — list projects visible to the current user (owned + shared via `project_members`), excluding soft-deleted (`deleted_at is null`).
  - `PATCH /api/projects/:id` — rename (and later other metadata edits); must check the caller has `owner` or `editor` role via `project_members`.
  - `POST /api/projects/:id/duplicate` — clone a project's row (new `id`/`short_id`, same `owner_id` as the duplicator, title suffixed "(copy)"); duplicating the CRDT document itself is not possible yet since `project_doc_state` doesn't exist until Job 015 — for now duplicate only creates a new empty project row, and this limitation must be called out in code and to the user (e.g. a TODO comment plus, if there's already a project-doc concept stubbed, wire it once Job 015 lands). Do not block this job on that — just don't silently pretend duplication is complete.
  - `DELETE /api/projects/:id` — soft delete (sets `deleted_at`), owner-only.
  - Authorization: every route resolves the caller's role from `project_members` and enforces it (viewer can't rename/delete; only owner can delete).
- `apps/web` UI:
  - A project list page (post-login landing page) showing the user's projects (owned + shared), with create/rename/duplicate/delete actions wired to the API above.
  - Basic empty state ("no projects yet — create one").
  - Route guard: unauthenticated users are redirected to the login flow from Job 005.

Out of scope:

- The actual canvas/editor the project list links into (Phase 2, Jobs 007+) — clicking a project can route to a placeholder page for now.
- Sharing UI (invites, role management) — PLAN.md places share-by-link in the MVP scope generally, but the `project_invites` table's actual UI is naturally paired with Job 022 (multiplayer sharing) since it's meaningless without collaborators to invite; this job only needs the `projects`/`project_members` CRUD, not invites.
- `visibility` (`public`/`link`) beyond storing the column — the public-gallery feature is explicitly a later phase (PLAN.md §3 "Later phases").

## Deliverables

- `apps/api/src/routes/projects.ts` implementing the five routes above with role checks.
- `apps/web` project list page + create/rename/duplicate/delete UI.
- Tests: role enforcement (viewer cannot rename/delete; non-member cannot see or act on a project), soft-delete excludes from listing, `short_id` uniqueness.

## Acceptance criteria

- Logging in, creating a project, seeing it in the list, renaming it, and it persisting across a page refresh — all work end to end (uses the DB from Job 004, no CRDT persistence needed yet since there's no doc content).
- A viewer-role member can see but not rename/delete a shared project (test this with two seeded users/roles even though the sharing _UI_ isn't built yet — you can seed `project_members` rows directly for the test).
- Soft-deleted projects disappear from `GET /api/projects` but remain in the database.
- `pnpm --filter api --filter web test` passes.

## Notes for the worker

- `short_id` generation: keep it simple (e.g. nanoid-style random string), just enforce the `unique` constraint from the migration.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md), and clearly flag in Handoff notes that "duplicate" is project-metadata-only until Job 015 exists.

## Handoff notes

**File layout — `apps/api/src/projects/`** (a per-domain folder, mirroring `apps/api/src/auth/`'s split from Job 005, rather than the single `apps/api/src/routes/projects.ts` the job file names — same rationale Job 005 gave for its own deviation: separating DB/role/route concerns keeps each independently testable):

- `short-id.ts` — `generateShortId()`: 8 random bytes, base64url-encoded (already URL-safe, no new dependency). Kept as simple as the job's own note allows.
- `roles.ts` — `resolveRole(projectId, userId)`: the single query every route uses to resolve the caller's role, reading straight from `project_members` (`role` column, `ProjectMemberRole` from `@scm/db`). Returns `null` for "no membership row at all," which every route treats as 404 ("acts like the project doesn't exist") rather than 403 — this is deliberate: it avoids leaking whether an arbitrary project id belongs to someone else. `canEdit`/`canDelete`/`canDuplicate` are the three policy predicates over that role: `canEdit` is `owner|editor` (PATCH), `canDelete` is `owner` only (DELETE), `canDuplicate` is any non-null role (POST .../duplicate — see below for why viewers are included). **This is the pattern for Job 022 (sharing UI/roles) and any future route that needs per-project permission checks to build on**: call `resolveRole`, branch on the result, don't hand-roll a new query.
- `store.ts` — all the Kysely queries: `createProject` (transaction: insert `projects` row + insert the `owner` `project_members` row together, retrying on a `short_id` unique-violation the same way `auth/session.ts`'s `createSession` retries on a token-hash collision), `listProjectsForUser` (single join on `project_members` — see below), `findActiveProjectById`, `renameProject` (bumps `updated_at` via `sql\`now()\``since there's no DB trigger for it),`softDeleteProject`, `duplicateProject`.
- `routes.ts` — `projectRoutes`, a plain `FastifyPluginAsync` (no options needed, unlike `authRoutes`) registering all five routes, each gated by `{ preHandler: fastify.authenticate }` and then `const user = request.user!;`, per Job 005's handoff note. Serializes DB rows to camelCase JSON via a local `serializeProject` helper.
- `routes.test.ts` — 19 tests against a real Postgres connection (same precedent as `auth/*.test.ts`), driving `buildApp()` + `app.inject()`. Seeds users directly (`db.insertInto("users")...`) and mints sessions via `auth/session.ts`'s `createSession()` directly rather than going through the Discord flow — Job 006 doesn't need to touch OAuth at all. Covers: default title / unique `short_id` / owner-membership-row-on-create; list scoping (owned + shared, excludes non-member's projects, excludes soft-deleted); rename by owner and by editor; rename **rejected (403)** for a viewer; rename/delete/duplicate all **404** for a non-member (not 403 — see `roles.ts` above); empty-title rejected (400); delete by owner (soft, persists in DB, disappears from list) and **rejected (403)** for editor and viewer; duplicate by owner and by a **viewer** (see below), with the `metadataOnly: true` flag asserted in the response; duplicate 404 for a non-member.

**Registered in `apps/api/src/app.ts`** as `await app.register(projectRoutes);`, right after `authRoutes`, both as sibling plugins on the root app (relying on `sessionPlugin`'s `fastify-plugin` wrapping for `fastify.authenticate`/`request.user` visibility, exactly as Job 005's handoff note anticipated).

**Listing query — deliberate design choice:** `listProjectsForUser` is a single `projects INNER JOIN project_members ... WHERE project_members.user_id = :userId AND projects.deleted_at IS NULL`, not a UNION of an "owned" branch (filtered on `owner_id`) and a "shared" branch. Every project gets an `owner` `project_members` row at creation time (`createProject`'s transaction), so `project_members` alone is a complete, single source of truth for "can this user see this project" — owned and shared projects are the same query. This means the query doesn't hit `projects_owner_id_index` (the partial index Job 004 created on `owner_id where deleted_at is null`) — it hits `project_members_user_id_index` instead, then filters `deleted_at is null` on the joined `projects` rows. Correctness (and query simplicity) was judged more valuable than exercising that specific index; flagging this in case a later job cares about `EXPLAIN` output for that index specifically.

**Duplicate is project-metadata-only — where this is marked:**

- Code: `apps/api/src/projects/store.ts`'s `duplicateProject` has a `TODO(job-015)` doc comment directly above the function, explaining that `project_doc_state` doesn't exist yet and that whoever adds it must also extend this function to copy/seed the source project's document.
- API response: `POST /api/projects/:id/duplicate`'s JSON body includes `"metadataOnly": true` (added explicitly in `routes.ts`, not just implied) — a stable field Job 015 (or `apps/web`) can key off once real duplication exists, to tell old-shaped responses from new ones if it matters.
- UI: `apps/web/src/routes/ProjectsPage.tsx`'s `handleDuplicate` shows a dismissible notice after a successful duplicate: _"…Note: only the project's settings were copied — canvas content duplication isn't available yet."_ This is the user-facing surfacing the job explicitly required ("must be called out in code **and to the user**").
- **Who can duplicate**: any project member (`owner`/`editor`/`viewer`), not just owner/editor — this wasn't specified by PLAN.md or the job file, so I made a judgment call: duplicating creates a _new_ project owned by the duplicator and never mutates the source, so it's closer to "make my own copy" than an edit of the original. `roles.ts`'s `canDuplicate` is the single place this policy lives if it needs tightening later.

**`apps/web` changes:**

- `apps/web/src/api/projects.ts` — fetch wrapper (`listProjects`/`createProject`/`renameProject`/`duplicateProject`/`deleteProject`), typed against the API's camelCase JSON shape, throwing `ApiError` (carries `status`/`body`) on non-2xx. **Only sets `content-type: application/json` when a body is actually present** — worth calling out because it's a real bug I hit and fixed during manual browser testing: Fastify's default JSON body parser 400s with `FST_ERR_CTP_EMPTY_JSON_BODY` on a request that declares a JSON content-type but sends an empty body, which `duplicateProject`/`deleteProject` (POST/DELETE with no body) do. Automated tests didn't catch this because `app.inject()` in `routes.test.ts` never sets that header for a bodyless request — only a real browser `fetch()` call reproduces it. If a future job adds more bodyless POST/DELETE-style calls through this wrapper, this is already handled generically (not per-endpoint).
- `apps/web/src/routes/ProjectsPage.tsx` — the post-login landing page: list, create ("New project" button, default title), inline rename (click "Rename" -> input + Save/Cancel), duplicate (with the notice above), delete (owner-only, `window.confirm()` guard, no undo in the UI yet). Buttons are role-gated client-side to match `apps/api`'s enforcement (`canEdit`/`canDelete` mirrored locally) — purely a UX nicety; the server is the actual boundary.
- `apps/web/src/routes/ProjectPlaceholder.tsx` — the explicit out-of-scope stand-in for the canvas (PLAN.md Phase 2 / Job 007+). Shows short id / role / visibility and a "Back to projects" link.
- `apps/web/src/App.tsx` — reworked from Job 005's bare login link into: a persistent header (title + login/logout, unchanged behavior) and a body that's either the login prompt (route guard: unauthenticated/loading never render project content) or `ProjectsPage`/`ProjectPlaceholder` depending on local `View` state. **There is still no router library in `apps/web`** (no new dependency added) — `View` is plain `useState`, not URL-addressable, so project pages aren't bookmarkable/shareable yet. This is a real gap, not hidden: flagged inline in `App.tsx`'s `View` doc comment for whoever adds real routing (routes/index.ts's own placeholder comment already anticipated a router landing "later").
- `apps/web/vite.config.ts` — added `/api` to the dev-server proxy (alongside Job 005's `/auth`), same same-origin-cookie reasoning.

**A real bug found and fixed in shared infrastructure — `apps/api/src/db.ts`'s `closeDb()`:** while writing `routes.test.ts`, running the full 19-test file (but not smaller subsets reliably) made `afterAll(() => closeDb())` hang indefinitely under Vitest — up to 60s+ observed, never resolving on its own. Isolated by reproducing the exact same `buildApp`/`app.inject`/Kysely-query sequence directly via `tsx` outside Vitest, where it consistently closed in single-digit milliseconds — so this is not a real connection or transaction leak in application code, and it reproduced identically under both Vitest's `pool: 'threads'` and `pool: 'forks'`. Fixed by having `closeDb()` call `postgresClient.end({ timeout: 5 })` directly instead of `db.destroy()` (which is otherwise equivalent — `kysely-postgres-js`'s `destroy()` just calls `postgres.end()` with no arguments and no timeout, i.e. an unbounded graceful drain). Verified fixed across 3 repeated full-suite runs. **This fix benefits every future `apps/api` test file**, not just this job's — worth knowing if anyone hits a similar hang later and wonders why `closeDb()` looks different from a plain `db.destroy()` call.

**Docker/Postgres status — still broken on this machine, same as Jobs 004 and 005:** `docker info` hung again (backgrounded after a 20s timeout, zero output). Did not attempt to force-kill/restart Docker Desktop, same reasoning as prior jobs. Used the same native-Postgres fallback: a throwaway Postgres 16 instance (`initdb`/`pg_ctl` from `C:\Program Files\PostgreSQL\16\bin`, fresh data dir under this session's scratchpad, port 5434), migrated cleanly with `pnpm --filter @scm/api db:migrate` (all 5 migrations applied with no drift), used for all automated tests above and for a full manual browser smoke test (see below), then stopped with `pg_ctl stop -m fast` at the end. `infra/.env`'s `DATABASE_URL` was pointed at port 5434 for the duration and restored to the docker-compose default (`5432`) before finishing — `infra/.env` is gitignored, so this never touched anything committed. **Follow-up for whoever picks up Job 007+**: once Docker Desktop works again, run `docker compose -f infra/docker-compose.yml up -d && pnpm db:migrate` and re-run `pnpm -r test` against it as a parity check, per Jobs 004/005's same standing recommendation.

**Manual end-to-end verification (beyond the automated suite):** ran `pnpm --filter @scm/api dev` and the web dev server (Vite) against the throwaway Postgres, and drove the real app in a browser (login state simulated by minting a session directly via `auth/session.ts`'s `createSession()` and setting the `sfm_session` cookie via `document.cookie` — Discord itself is still unverified live, same standing gap Job 005 already flagged, unrelated to this job's scope). Confirmed by hand: route guard (anonymous -> login prompt, no project content); create; inline rename (persists — re-checked with a full page reload); duplicate (new row, `(copy)` suffix, `metadataOnly` notice shown and dismissible); delete (via direct API call — `window.confirm()`'s native dialog isn't drivable through the browser automation tool, so the in-UI button's own confirm-guarded path wasn't clicked through the dialog itself, only the underlying `deleteProject()` call it invokes); click-through from the list into `ProjectPlaceholder` and back; and — importantly — a second, viewer-role user seeing only the one shared project with **only a "Duplicate" button** (no Rename/Delete), matching `roles.ts` exactly. This pass is what caught the two real bugs listed above (`FST_ERR_CTP_EMPTY_JSON_BODY` and the `closeDb()` hang) — both fixed and re-verified.

**Deviations from the spec:**

- Route file organized as `apps/api/src/projects/*.ts` rather than the single `apps/api/src/routes/projects.ts` the job file names — see "File layout" above.
- `canDuplicate` allows viewers, which the job file didn't explicitly specify either way — see "Duplicate is project-metadata-only" above for the reasoning.
- 404 (not 403) for a non-member acting on PATCH/DELETE/duplicate — an interpretation of "non-member cannot see or act on a project" as "acts exactly like it doesn't exist," not tested against by name in the job's acceptance criteria but consistent with its spirit (not leaking existence).
- No router library added to `apps/web` — project navigation is in-memory `useState`, not URL-addressable. Flagged above as a real, known gap rather than something papered over.
