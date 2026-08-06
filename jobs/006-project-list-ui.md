# Job 006: Project list UI + project CRUD

**Phase:** 1 · Auth & projects
**Status:** Not started
**Depends on:** 005 (Discord OAuth2 — needs a logged-in user to own projects)

## Context

Read [`PLAN.md`](../PLAN.md) section **3. Feature Scope → MVP → Platform** (project list: create/rename/duplicate/soft-delete) and section **4. Data Model → Identity, projects, sharing** (the `projects` table, especially `short_id`, `visibility`, `deleted_at` soft-delete). This is the last Phase-1 job — after this, Phase 2 starts building the actual canvas.

## Scope

In scope:
- `apps/api` REST routes (authenticated, using the session middleware from Job 005):
  - `POST /api/projects` — create, defaults `title` to `'Untitled Factory'`, generates a unique URL-friendly `short_id`, sets `owner_id` to the current user, and inserts an `owner` row into `project_members`.
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
- A viewer-role member can see but not rename/delete a shared project (test this with two seeded users/roles even though the sharing *UI* isn't built yet — you can seed `project_members` rows directly for the test).
- Soft-deleted projects disappear from `GET /api/projects` but remain in the database.
- `pnpm --filter api --filter web test` passes.

## Notes for the worker

- `short_id` generation: keep it simple (e.g. nanoid-style random string), just enforce the `unique` constraint from the migration.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md), and clearly flag in Handoff notes that "duplicate" is project-metadata-only until Job 015 exists.
