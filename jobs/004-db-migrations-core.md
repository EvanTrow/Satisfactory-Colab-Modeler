# Job 004: Core DB migrations (users, sessions, projects, sharing)

**Phase:** 1 · Auth & projects
**Status:** Not started
**Depends on:** 001 (monorepo scaffold — needs `db/migrations/`, the Postgres docker-compose, and `apps/api`)

## Context

Read [`PLAN.md`](../PLAN.md) section **4. Data Model (Postgres)**, specifically the "Identity, projects, sharing" subsection (the `users`, `sessions`, `projects`, `project_members`, `project_invites` tables). Do **not** create the CRDT/doc-state tables (`project_doc_state`, `project_doc_updates`, `project_versions`) or the relational projection tables (`proj_nodes`, `proj_edges`) yet — those belong to Jobs 015 and 025 respectively.

## Scope

In scope:
- Migration tooling setup in `db/migrations/` (per PLAN.md's DB choice: `postgres.js` + Kysely, typed SQL, no heavy ORM). Pick a migration runner compatible with that stack (Kysely has its own migration API — use it) and wire a `pnpm db:migrate` script in `apps/api` or root.
- The exact schema from PLAN.md §4 for: `users`, `sessions`, `projects`, `project_members`, `project_invites`, including all constraints (`check` clauses, foreign keys, `on delete cascade`, the partial index on `projects (owner_id) where deleted_at is null`, and the index on `project_members (user_id)`).
- Kysely type definitions generated or hand-written for these tables, exported from `apps/api` (or a shared location if `packages/shared` is more appropriate — use judgment, but keep DB types close to the migrations to avoid drift).
- A `apps/api/src/db.ts` (or similar) setting up the `postgres.js` + Kysely connection using `DATABASE_URL` from `.env`.
- Seed/reset scripts for local dev convenience (optional but recommended: `pnpm db:reset`).

Out of scope:
- `project_doc_state`, `project_doc_updates`, `project_versions` (Job 015).
- `proj_nodes`, `proj_edges` (Job 025).
- Any actual auth logic — this job only creates the tables auth will use (Job 005 implements the OAuth flow against them).

## Deliverables

- Migration files under `db/migrations/` creating all five tables in the correct dependency order, matching PLAN.md §4's SQL exactly (including comments where they carry design intent, e.g. "Discord access/refresh tokens are deliberately NOT stored").
- Kysely `Database` interface types matching the schema.
- `apps/api/src/db.ts` connection setup.
- `pnpm db:migrate` (and ideally `db:reset`) scripts that work against the `infra/docker-compose.yml` Postgres instance from Job 001.

## Acceptance criteria

- `docker compose -f infra/docker-compose.yml up -d` then `pnpm db:migrate` creates all five tables with correct columns, types, constraints, and indices — verify with `\d+ <table>` in `psql` or an equivalent introspection check.
- Foreign key and check constraints actually reject bad data (e.g. inserting a `project_members.role` outside `('owner','editor','viewer')` fails; deleting a `users` row cascades to `sessions`).
- Kysely queries against these tables type-check.
- Migrations are idempotent/re-runnable in a fresh database with no manual intervention.

## Notes for the worker

- Match column names, types, and constraints from PLAN.md §4 exactly — later jobs (especially 005, 006) will write code against this exact shape.
- `discord_id` is the stable join key for `users`; `sessions.token_hash` stores a SHA-256 hash of the opaque cookie value, never the raw token.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
