# Job 001: Monorepo scaffold

**Phase:** 0 · Foundations
**Status:** Done
**Depends on:** — (first job)

## Context

Read [`PLAN.md`](../PLAN.md) section **7. Project Structure** and the top of **8. Phased Roadmap** (Phase 0 row) before starting. This job lays the empty skeleton every later job builds inside. No feature code, no game logic, no DB schema yet — just a monorepo that builds, lints, and runs.

## Scope

In scope:
- pnpm workspaces + Turborepo at the repo root.
- Root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, root `tsconfig.base.json`, shared ESLint + Prettier config.
- `apps/web/`: Vite + React + TypeScript + Tailwind CSS scaffold. Default starter page is fine (e.g. a placeholder route rendering "Satisfactory Colab Modeler").
- `apps/api/`: Fastify + TypeScript scaffold with a single `/health` route returning `{ ok: true }`.
- `apps/realtime/`: minimal placeholder package (empty `src/index.ts` with a TODO comment referencing Job 020) — just enough to exist as a workspace member; do not implement Hocuspocus here.
- Empty but valid workspace packages: `packages/rational/`, `packages/gamedata/`, `packages/solver/`, `packages/ydoc/`, `packages/shared/` — each with a minimal `package.json`, `tsconfig.json`, and an `src/index.ts` exporting nothing but a placeholder comment. (Jobs 002/003/007/017 fill these in.)
- `db/migrations/` directory (empty, with a `.gitkeep` or README stub — Job 004 adds the first migration).
- `infra/`: a `docker-compose.yml` that brings up a local Postgres instance (for later jobs — nothing needs to consume it yet). Include a `.env.example` with `DATABASE_URL`.
- Root README with dev setup instructions (`pnpm install`, `pnpm dev`, `docker compose -f infra/docker-compose.yml up`).
- `.gitignore` covering `node_modules`, build output, `.env`, etc.

Out of scope (leave for later jobs):
- Any actual rational arithmetic, game data parsing, canvas, or solver code.
- Auth, sessions, or any DB tables.
- CI pipeline config (not in PLAN.md's scope; skip unless asked).

## Deliverables

- Repo matches the tree in PLAN.md §7 (`apps/{web,api,realtime}`, `packages/{rational,gamedata,solver,ydoc,shared}`, `db/migrations/`, `infra/`).
- `pnpm install` succeeds from the repo root.
- `pnpm dev` (via Turborepo) starts `apps/web` (Vite dev server) and `apps/api` (Fastify) concurrently without errors.
- `pnpm lint` and `pnpm typecheck` (or equivalent Turborepo pipeline tasks) run cleanly across all workspaces, even though most contain placeholder code.
- `docker compose -f infra/docker-compose.yml up -d` brings up a Postgres container reachable at the `DATABASE_URL` in `.env.example`.

## Acceptance criteria

- Fresh clone → `pnpm install` → `pnpm dev` works with zero manual fixes.
- Visiting the Vite dev server shows the placeholder page; hitting the Fastify `/health` route returns `{ ok: true }`.
- `pnpm -r build` (recursive build across all workspace packages) completes with no errors, even for the placeholder packages.
- No workspace package has an unresolved dependency or circular reference.

## Notes for the worker

- Use TypeScript everywhere (per PLAN.md's key-libraries table). Strict mode on in `tsconfig.base.json`.
- Package manager is pnpm — don't introduce npm/yarn lockfiles.
- Keep placeholder packages genuinely minimal; the goal is a scaffold that later jobs slot into, not speculative structure.
- When done, update this file's Status line and the row in [`INDEX.md`](INDEX.md), and leave a **Handoff notes** section here noting any deviations from the PLAN.md tree (e.g. if a config file needed a different name/location) so downstream jobs aren't surprised.

## Handoff notes

Verified with actual commands (not just inspection): `pnpm install`, `pnpm lint` (`eslint .`), `pnpm typecheck` (`turbo run typecheck`, 8/8 packages pass), `pnpm build` and `pnpm -r build` (8/8 packages build, Vite production bundle included), `pnpm dev` (Vite on :5173 + Fastify on :3001 concurrently — confirmed `/health` returns `{"ok":true}` and the placeholder page renders with Tailwind styling via a real browser check), and `docker compose -f infra/docker-compose.yml up -d` (Postgres 16-alpine reachable at the `DATABASE_URL` in `infra/.env.example`, healthcheck passing).

Deviations / decisions for downstream jobs:

- **Package naming:** every workspace package is scoped `@scm/*` (`@scm/web`, `@scm/api`, `@scm/realtime`, `@scm/rational`, `@scm/gamedata`, `@scm/solver`, `@scm/ydoc`, `@scm/shared`). PLAN.md §7 doesn't name a scope; pick this one up when importing across packages (e.g. `import {...} from "@scm/rational"`).
- **"Just-in-time" internal packages:** `packages/*` ship `"main"`/`"types"`/`"exports"` pointing straight at `./src/index.ts` (Turborepo's documented pattern for internal packages), not at `dist/`. This means `apps/web` (Vite/esbuild) can import them with zero build step in dev. Each package still has a working `build` script (`tsc -p tsconfig.json` emitting to `dist/`) so `pnpm -r build` and standalone typechecking succeed, but that `dist/` output is currently unused by any consumer. **Open question for whoever wires up `apps/api`/`apps/realtime` to actually import these packages (Jobs 002/003/007/017+):** a plain `tsc`-built `apps/api` run via `node dist/index.js` cannot execute an imported package whose `main` points at a `.ts` file — only `tsx`/Vite/esbuild-based runners can. Either (a) give `apps/api`/`apps/realtime` an esbuild/tsup bundling step instead of a bare `tsc` build before this becomes load-bearing, or (b) switch the consumed packages' `main` to `dist/index.js` once they have real exports and accept a build-order dependency. Not a problem yet since nothing imports these packages.
- **`apps/api` and `apps/realtime` tsconfig use `module`/`moduleResolution: NodeNext`** (overriding the root `tsconfig.base.json`'s `Bundler` mode) since they run directly under Node. `apps/web` keeps `Bundler` resolution (via `tsconfig.app.json`/`tsconfig.node.json`, which extend the base and only override what Vite needs). Relative imports in `apps/api`/`apps/realtime` will need explicit `.js` extensions under `NodeNext` once real code with relative imports is added — not an issue yet since `src/index.ts` has none.
- **Root `pnpm lint` is a single flat `eslint .` invocation**, not a Turborepo task — there's one `eslint.config.js` at the repo root (flat config) scoped by `files:` globs for `apps/web` (React + browser globals) vs. everything else (Node globals), with `resources/`, `dist/`, etc. ignored. No per-package `lint` script or `eslint` devDependency was added to any workspace package; only the root has `eslint`/`typescript-eslint`/etc. `turbo.json` intentionally has no `lint` task for the same reason. If a later job wants per-package lint caching via Turborepo, that'll need per-package `eslint` devDependencies and a `lint` script added back.
- **Tooling versions were deliberately pinned to caret-ranges anchored below TypeScript 6** (`"typescript": "^5.6.0"` everywhere, resolves to 5.9.x): as of this job, `typescript-eslint@8.66` declares a peer range of `typescript: ">=4.8.4 <6.1.0"`, and the npm registry's current `typescript@latest` is a `7.x` prerelease line. Don't bump the repo's TypeScript version without first checking `typescript-eslint`'s supported range, or `pnpm lint`/`typecheck` will start failing or warning.
- **`apps/web` uses Tailwind CSS v4** via the `@tailwindcss/vite` plugin (`vite.config.ts`) and a single `@import "tailwindcss";` in `src/index.css` — there is no `tailwind.config.js` (v4 doesn't require one for the default setup). If a later job needs custom theme tokens, that's a `@theme` block in CSS, not a JS config file, per Tailwind v4's convention.
- **`apps/web/src/{canvas,panels,collab,workers,routes}/`** each contain only a placeholder `index.ts` (`export {};`) so the directory structure from PLAN.md §7 exists and is a valid TS module; the first job that adds real code there should just start replacing that placeholder.
- **`infra/docker-compose.yml`** has inline defaults (`${POSTGRES_USER:-scm}` etc.) so `docker compose -f infra/docker-compose.yml up -d` works even without an `infra/.env` file present; `infra/.env.example` documents the same values plus the assembled `DATABASE_URL`. Copy it to `infra/.env` (gitignored) to override.
- **`pnpm-workspace.yaml`** sets `onlyBuiltDependencies: [esbuild]` so `pnpm install` doesn't stop for an interactive "approve build scripts" prompt (Vite's dependency chain pulls in esbuild's native postinstall). Add to this list if a future dependency needs the same treatment.
- Root `package.json` needed an explicit `"type": "module"` — without it, ESM syntax in `eslint.config.js` triggered a Node runtime warning (harmless but noisy) on every `pnpm lint` run.
- `db/migrations/` is empty except for `.gitkeep`, per scope — Job 004 adds the first real migration.
