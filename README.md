# Satisfactory Colab Modeler

A browser-based, real-time collaborative rebuild of [Satisfactory Modeler](https://satisfactorymodeler.itch.io/satisfactorymodeler) — plan Satisfactory factories on an infinite canvas with exact rational arithmetic, then edit them together like a Google Doc.

See [`PLAN.md`](./PLAN.md) for the full architecture and roadmap, and [`jobs/`](./jobs) for the job queue this project was built through.

**All 29 jobs in the roadmap are complete** (see [`jobs/INDEX.md`](./jobs/INDEX.md)) — the full MVP (Phases 0-5: auth, canvas editing, persistence, calculators, multiplayer) plus Phase 6 (the Full calculator, priority nodes, relational projection) and Phase 7 (blueprints, polish, i18n, accessibility, and production-deploy readiness) have all landed. This is a real, working application, not a scaffold.

## Project structure

```
apps/
  web/          Vite + React + TypeScript + Tailwind CSS — the browser client
  api/          Fastify + TypeScript — auth, projects, sharing, tickets, static SPA serving
  realtime/     Hocuspocus server (co-deployed with api in production) — CRDT sync, presence, roles
packages/
  rational/     BigInt exact rational arithmetic + parser/formatter
  gamedata/     game_data.json -> typed, indexed, validated; icon manifest
  solver/       the calculators (Manual/Basic/None/Full) — pure functions
  ydoc/         CRDT schema, mutation helpers, integrity reducer
  doc-storage/  Yjs <-> Postgres persistence (snapshot + incremental log, compaction, versions, relational projection) — shared by apps/api and apps/realtime
  shared/       zod schemas + types shared by web and api
resources/      extracted game data/assets (unchanged reference material)
db/migrations/  SQL migrations for the relational (non-CRDT) tables
infra/          Dockerfile, docker-compose.yml (local Postgres), deploy config, backups doc
```

## Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io/) 10+ (`corepack enable` will pick up the pinned version from `packageManager` in `package.json`)
- Docker + Docker Compose (for local Postgres)

## Dev setup

```sh
# 1. Install dependencies for every workspace
pnpm install

# 2. Bring up local Postgres (uses infra/.env if present, else the defaults below)
cp infra/.env.example infra/.env
docker compose -f infra/docker-compose.yml up -d

# 3. Run everything (apps/web on Vite, apps/api on Fastify) via Turborepo
pnpm dev
```

- `apps/web` dev server: http://localhost:5173
- `apps/api` dev server: http://localhost:3001 (try `GET /health` -> `{ "ok": true }`)
- Postgres: `postgresql://scm:scm@localhost:5432/scm` (see `infra/.env.example` for `DATABASE_URL`)

## Other commands

```sh
pnpm build       # turbo run build — recursive build across all workspaces
pnpm typecheck   # turbo run typecheck — tsc --noEmit across all workspaces
pnpm lint        # eslint . — lints the whole repo against the shared config
pnpm format      # prettier --write .
```

To stop and remove the local Postgres container:

```sh
docker compose -f infra/docker-compose.yml down
```

## Workspace conventions

- Package manager is **pnpm** (workspaces defined in `pnpm-workspace.yaml`); no npm or yarn lockfiles.
- Task orchestration is **Turborepo** (`turbo.json`); `pnpm dev`/`build`/`typecheck` at the root fan out to every workspace via its own `dev`/`build`/`typecheck` script.
- TypeScript everywhere, strict mode, configured once in `tsconfig.base.json` and extended per workspace.
- Internal `packages/*` are consumed directly from `src/` (no build step required to use them from `apps/web` or `apps/api` in dev) but each still has a working `build` script so `pnpm -r build` succeeds standalone.

## Production deploy

> **Scope boundary, stated plainly: this repo is *deploy-ready*, not *deployed*.** Everything below the Dockerfile itself has been built and verified **locally only** — there is no live production deployment, no real cloud hosting account, no real Sentry project, and no real backup running anywhere. Job 029 (`jobs/029-a11y-deploy.md` — see its Handoff notes for the full detail) deliberately stopped at that line: creating a cloud account, entering billing details, and deploying to a real shared host all require a human's own direct action, not an autonomous agent's. Everything described here was written, and where possible *proven*, without ever crossing that line — the Docker image was genuinely built and run locally against a throwaway Postgres container (migrations, static SPA serving, API auth, and the `/collab` WebSocket proxy all verified working end to end), but never pushed anywhere real.

### What's already done (verified locally)

- **`infra/Dockerfile`** — a working multi-stage build producing ONE image containing `apps/web` (built static SPA), `apps/api`, and `apps/realtime`, per PLAN.md's "single container host" decision. `infra/docker/entrypoint.mjs` starts all three (api, realtime, and a same-origin reverse proxy, `infra/docker/proxy/proxy.mjs`) as one supervised unit — if any one dies, the whole container exits so the host's restart policy recreates it. Build/run it yourself:
  ```sh
  docker build -f infra/Dockerfile -t scm:local .
  docker run --rm -p 8080:8080 --init \
    -e DATABASE_URL=postgresql://user:pass@host:5432/db \
    -e COOKIE_SECRET=<random> -e REALTIME_TICKET_SECRET=<random> -e REALTIME_INTERNAL_SECRET=<random> \
    -e DISCORD_CLIENT_ID=... -e DISCORD_CLIENT_SECRET=... -e DISCORD_REDIRECT_URI=http://localhost:8080/auth/discord/callback \
    scm:local
  ```
  then open `http://localhost:8080`. (Discord login won't work without a real Discord application registered with that exact redirect URI — see step 2 below.)
- **`infra/fly.toml`** — deploy config for Fly.io (chosen per PLAN.md §10's confirmed-decisions list; Railway/Render would need their own equivalent config, this app has nothing Fly-specific in it otherwise). Inert until a human runs `fly launch`/`fly deploy` — see the file's own header comment for the exact command sequence.
- **`infra/BACKUPS.md`** — what to back up (the whole Postgres database — see that file for why nothing else needs it), suggested cadence, and a restore runbook, written against whichever managed-Postgres host's *native* backup feature you end up using. `infra/scripts/backup.sh` is a plain-`pg_dump` fallback, verified locally (dumped the real dev database, restored it into a scratch database, confirmed the data came back) — only needed if your chosen host has no native backup feature at all.
- **Error tracking SDK wiring** — `@sentry/node` in `apps/api`/`apps/realtime`, `@sentry/react` in `apps/web`. Every capture call is a genuine no-op until a real DSN is supplied (verified with real unit tests mocking the SDK — see each app's `src/monitoring/sentry.test.ts`); this repo has never sent anything to a real Sentry project because none exists. Captures unhandled exceptions/rejections in all three apps, every 5xx Fastify route error, and — per PLAN.md's own callout — every time the CRDT integrity reducer (Job 022) actually repairs something, since a repair firing usually means a real bug elsewhere even though the reducer's whole job is to make it non-fatal.
- **Accessibility pass** — see `jobs/029-a11y-deploy.md`'s Handoff notes for the full writeup (focus trapping, ARIA labels, contrast fixes, keyboard-only verification, and documented canvas limitations).

### What a human still has to do, concretely

1. **Pick and create a hosting account.** This README's config targets Fly.io (`infra/fly.toml`) — create an account at <https://fly.io>, install `flyctl`, and run `fly auth login`. (Railway/Render are equally viable; you'd write an equivalent `railway.json`/`render.yaml` instead of using `infra/fly.toml`, and `infra/Dockerfile` itself needs no changes either way.)
2. **Register a Discord OAuth2 application** at <https://discord.com/developers/applications> (if one doesn't already exist from local dev) and add an OAuth2 redirect matching your real production URL exactly, e.g. `https://your-app.fly.dev/auth/discord/callback` — this MUST match `DISCORD_REDIRECT_URI` byte-for-byte or every login attempt fails at Discord's own redirect-URI check.
3. **Provision a managed Postgres instance** — Fly Managed Postgres (`fly postgres create`, or attach an existing one via `fly postgres attach`), or any other managed provider (Neon, Supabase, RDS, etc.) with automated backups enabled — see `infra/BACKUPS.md` for exactly what to enable and why.
4. **Run the database migrations once** against that instance — `infra/docker/entrypoint.mjs` does this automatically on every container boot by default (safe/idempotent — Kysely's migrator tracks what's already applied), or set `RUN_MIGRATIONS_ON_BOOT=false` and run them as an explicit deploy step instead: `DATABASE_URL=... pnpm --filter @scm/api db:migrate`.
5. **Set every secret** the app needs, via the host's own secrets mechanism (`fly secrets set KEY=value ...` for Fly — **never** commit these to `infra/.env` or anywhere else in git):
   - `DATABASE_URL` — from step 3 (Fly's `postgres attach` sets this automatically).
   - `COOKIE_SECRET`, `REALTIME_TICKET_SECRET`, `REALTIME_INTERNAL_SECRET` — three independent random strings (`openssl rand -hex 32` each). Falls back to an insecure, publicly-known dev default if unset — **do not deploy without setting these for real.**
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` — from step 2.
   - `DISCORD_REDIRECT_URI` — a plain (non-secret) config value, set via `infra/fly.toml`'s `[env]` block instead of a Fly secret; update it to match step 2 exactly.
   - `SENTRY_DSN` (Node apps) and `VITE_SENTRY_DSN` (browser bundle, must be set **before** `apps/web`'s build step, not just at container runtime — see `infra/.env.example`'s own comment on why) — from step 6. Leave both unset to keep error tracking off entirely; nothing else needs to change.
6. **Create a Sentry project** (or self-hosted equivalent) at <https://sentry.io> if you want error tracking live — one project per platform is Sentry's own convention (Node for `apps/api`/`apps/realtime`, or share one Node project between them; React for `apps/web`), each giving you its own DSN for step 5. Verify it's working by deliberately triggering an error in the deployed app (e.g. temporarily add a route that throws) and confirming it appears in the Sentry dashboard within a minute or two.
7. **Deploy**: `fly launch --config infra/fly.toml --dockerfile infra/Dockerfile` (first time) or `fly deploy` (subsequent). Confirm `https://your-app.fly.dev/health` returns `{"ok":true}`, then do a real end-to-end pass: log in with Discord, create a project, add a node via the Recipe Chooser, and — with a second browser/incognito window logged in as a different Discord account with an invite link — confirm multiplayer sync and presence work over the real deployed WebSocket.
8. **Confirm backups are actually running** per `infra/BACKUPS.md` — check the provider's dashboard/CLI for at least one completed backup before considering this genuinely production-ready, not just deployed.
