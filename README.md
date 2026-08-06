# Satisfactory Colab Modeler

A browser-based, real-time collaborative rebuild of [Satisfactory Modeler](https://satisfactorymodeler.itch.io/satisfactorymodeler) — plan Satisfactory factories on an infinite canvas with exact rational arithmetic, then edit them together like a Google Doc.

See [`PLAN.md`](./PLAN.md) for the full architecture and roadmap, and [`jobs/`](./jobs) for the job queue this project is being built through.

This repository is currently a **scaffold**: the monorepo structure, tooling, and empty workspace packages exist, but no feature code has landed yet (see `jobs/001-monorepo-scaffold.md`).

## Project structure

```
apps/
  web/        Vite + React + TypeScript + Tailwind CSS — the browser client
  api/        Fastify + TypeScript — auth, projects, sharing, tickets
  realtime/   Hocuspocus server (co-deployed with api) — placeholder for now
packages/
  rational/   BigInt exact rational arithmetic + parser/formatter
  gamedata/   game_data.json -> typed, indexed, validated; icon manifest
  solver/     the calculators (Manual/Basic/None/Full) — pure functions
  ydoc/       CRDT schema, mutation helpers, integrity reducer
  shared/     zod schemas + types shared by web and api
resources/    extracted game data/assets (unchanged reference material)
db/migrations/  SQL migrations for the relational (non-CRDT) tables
infra/        docker-compose.yml + deploy config
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
