# Job 029: production image for the "single container host with managed
# Postgres" decision confirmed in PLAN.md's intro. One image, three
# processes at runtime (`apps/api`, `apps/realtime`, and a same-origin
# reverse proxy — see `infra/docker/entrypoint.mjs`'s header comment for
# exactly why all three, and `infra/docker/proxy/proxy.mjs`'s for the
# routing rule), fed by `apps/web`'s static build served straight out of
# `apps/api` (see `apps/api/src/staticSite.ts`).
#
# Build (from the repo root):
#   docker build -f infra/Dockerfile -t scm:local .
# Run (see README.md's "Production deploy" section for the full env var
# list — this is the minimum to boot against a real Postgres):
#   docker run --rm -p 8080:8080 \
#     -e DATABASE_URL=postgresql://user:pass@host:5432/db \
#     -e COOKIE_SECRET=... -e REALTIME_TICKET_SECRET=... -e REALTIME_INTERNAL_SECRET=... \
#     -e DISCORD_CLIENT_ID=... -e DISCORD_CLIENT_SECRET=... -e DISCORD_REDIRECT_URI=... \
#     scm:local
#
# NOT a multi-stage size-optimized image (see this job's own Handoff notes
# in jobs/029-a11y-deploy.md for why: `apps/api`/`apps/realtime` need the
# full pnpm workspace `node_modules` — including `tsx`, a devDependency —
# at runtime, not just production dependencies, because of the
# `@scm/ydoc`/`@scm/gamedata`/`@scm/rational` JIT-package gap explained in
# `entrypoint.mjs`'s own header comment; pruning devDependencies here would
# reintroduce the exact bug this Dockerfile exists to prove doesn't happen).
# A real size-optimization pass is flagged as a legitimate future
# improvement, not a correctness requirement this job needs to solve.

FROM node:20-alpine AS build
WORKDIR /app

# Matches package.json's own "packageManager" field exactly, so the image
# uses the identical pnpm version this repo's lockfile was generated with.
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

# Copying the whole source tree in one layer (rather than package.json
# files first, source second, for better layer-cache reuse across
# dependency-only vs source-only changes) is a deliberate simplification —
# see this file's own header comment on why build-time Docker layer
# caching was left as a future improvement rather than solved now.
COPY . .

RUN pnpm install --frozen-lockfile
# Builds every workspace: packages/* (rational/gamedata/solver/ydoc/shared/
# doc-storage), apps/api, apps/realtime (all `tsc`), and apps/web (`vite
# build`, producing the static SPA `apps/web/dist` that
# `apps/api/src/staticSite.ts` serves in the runtime image below). Also the
# one real type-safety gate this image gets — a type error anywhere in the
# workspace fails the Docker build here, before an image is ever produced.
RUN pnpm -r build

# The reverse proxy is deliberately NOT a pnpm workspace member (see
# infra/docker/proxy/package.json's own header comment) — its dependency
# (http-proxy) is installed with a plain, isolated `npm install` instead.
RUN npm install --prefix infra/docker/proxy --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

# Runs as a real non-root user rather than the image's default root —
# standard container hardening with no functional downside here (nothing
# this app does needs root: it binds a high port (>1024) and reads/writes
# only its own working directory).
RUN addgroup -S scm && adduser -S scm -G scm

# The WHOLE built workspace, in one copy — deliberately not a curated
# subset. pnpm's default `node_modules` layout is "strict": besides the
# root `node_modules/.pnpm` virtual store, EVERY workspace package
# (`apps/api`, `apps/realtime`, each `packages/*`, `db`) has its OWN
# `node_modules/` full of symlinks into that store, scoped to exactly that
# package's own declared dependencies. A first attempt at this Dockerfile
# copied only the root `node_modules` plus a hand-picked list of
# directories and failed at container boot with `Cannot find package
# 'kysely'` — `kysely` really is installed, just inside
# `apps/api/node_modules`, which that version never copied. Copying `/app`
# as a single unit is what actually gets every one of those per-package
# `node_modules` folders (and their relative symlinks into the shared
# store) copied consistently, with no risk of silently missing the next
# one. `.dockerignore` already keeps `apps/*/src`-adjacent dev-only bulk
# (test files, `.turbo`, etc.) out of the build context in the first
# place — see this file's own header comment on why further slimming this
# runtime layer is a real but deliberately deferred optimization.
COPY --from=build /app ./

# `apps/api/src/staticSite.ts` is a no-op unless this is set — this is the
# one env var this Dockerfile itself sets (a deployment fact: "this image
# co-locates the web build right next to the api"), as opposed to every
# secret/DATABASE_URL/etc., which are deliberately left for the deployer to
# supply (see this file's own `docker run` example above and README.md).
ENV WEB_DIST_DIR=/app/apps/web/dist
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER scm

# `--init` at `docker run`/the host platform's equivalent is what should
# supply real PID-1 signal/zombie handling (see entrypoint.mjs's own header
# comment on why this script deliberately doesn't try to BE that) — Fly.io
# and Railway both run containers with an init process already; a bare
# `docker run` needs `--init` passed explicitly (documented in README.md).
ENTRYPOINT ["node", "infra/docker/entrypoint.mjs"]
