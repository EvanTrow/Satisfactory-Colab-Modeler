#!/usr/bin/env node
// Job 029: the single production container's entrypoint. Starts THREE
// processes side by side — `apps/api`, `apps/realtime`, and the same-origin
// reverse proxy (`infra/docker/proxy/proxy.mjs`) — because PLAN.md's
// confirmed "single container host" decision means all of it lives in one
// container, not because Node/Docker have any built-in notion of "co-run
// these". If any one of the three exits, this script kills the other two
// and exits non-zero so the host platform's own restart policy (every
// mainstream host — Fly.io/Railway/Render/plain `docker run --restart`)
// recreates the whole container rather than limping along with a partially
// dead app.
//
// A real init/process-supervisor (`tini`, `dumb-init`, `pm2`) would do this
// more robustly (proper zombie-process reaping as PID 1, etc.) — this is
// the minimal amount of code that gets genuinely correct behavior for this
// specific, fixed set of three children, kept in plain Node rather than a
// shell script specifically because Alpine's default `/bin/sh` (busybox
// ash, not bash) lacks `wait -n`, which this exact "whichever child exits
// first wins" logic needs. Flagged in jobs/029's Handoff notes as a
// reasonable target for a later hardening pass if this ever needs to run
// literally as container PID 1 without `docker run --init` (this
// Dockerfile passes `--init`-equivalent behavior via `tini`, see its own
// header comment, specifically so this script never has to be a real init
// process itself).
import { spawn } from "node:child_process";

/**
 * Runs pending Postgres migrations before anything else starts, unless
 * explicitly disabled. Uses the already-typechecked, already-built
 * `apps/api/dist/db/migrate.js` (Job 004's migration runner) via `tsx`, not
 * plain `node` — a first attempt at this file assumed plain `node` would
 * be enough here, reasoning that `migrate.js` only imports `@scm/doc-storage`
 * (ships a real `dist/`, Job 020) and `@scm/db` (type-only, erased at
 * compile time). That reasoning missed that ES module imports evaluate a
 * module's ENTIRE graph, not just the specific names imported — `@scm/
 * doc-storage`'s own barrel `index.js` also re-exports `projection.ts`,
 * which has real (non-type) imports of `@scm/rational`/`@scm/ydoc`, so
 * merely importing `{ closeDb, db }` from `@scm/doc-storage` pulls those
 * two JIT-only packages in regardless — confirmed live, the exact
 * `ERR_UNKNOWN_FILE_EXTENSION ".ts"` failure `apps/api`/`apps/realtime`'s
 * own entrypoints below exist to avoid. Same fix, same reasoning as those.
 */
async function runMigrationsIfEnabled() {
  if (process.env.RUN_MIGRATIONS_ON_BOOT === "false") {
    console.log("[entrypoint] RUN_MIGRATIONS_ON_BOOT=false — skipping migrations.");
    return;
  }
  console.log("[entrypoint] running database migrations...");
  await new Promise((resolve, reject) => {
    const child = spawn("apps/api/node_modules/.bin/tsx", ["apps/api/dist/db/migrate.js"], { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`migrate.js exited with code ${code}`));
    });
    child.on("error", reject);
  });
  console.log("[entrypoint] migrations up to date.");
}

/**
 * `apps/api`/`apps/realtime`'s compiled entrypoints both transitively
 * import `@scm/ydoc` at runtime (`apps/realtime/src/server.ts` directly;
 * `apps/api` via `@scm/doc-storage`'s `projection.ts`, which does real
 * (non-type-only) imports of BOTH `@scm/ydoc` and `@scm/rational`) — and
 * `@scm/ydoc` itself imports `@scm/gamedata`. None of those three ship a
 * built `dist/` (deliberately — see the root README's "Internal packages/*
 * are consumed directly from src/... no build step required... in dev" and
 * Job 020/022's Handoff notes on why converting them would break that dev
 * workflow for `apps/web`'s own Vite consumption). A plain `node
 * dist/index.js` resolves their bare `@scm/ydoc` import to
 * `packages/ydoc/package.json`'s `"main": "./src/index.ts"` and then fails
 * outright — Node cannot execute `.ts`. `tsx` is what dev already uses for
 * these exact two apps (`"dev": "tsx watch src/index.ts"`, unchanged since
 * Job 001) — running their (already built, already typechecked) compiled
 * `dist/index.js` through `tsx` instead of plain `node` costs a small
 * startup-time transpilation hit and nothing else, and resolves this
 * exact gap without touching any package's `main`/`exports` field or
 * `apps/web`'s dev-time JIT consumption of the same packages.
 *
 * `tsxBin` is each app's OWN `node_modules/.bin/tsx`
 * (`apps/api/node_modules/.bin/tsx`, `apps/realtime/node_modules/.bin/tsx`),
 * not a root-level one — confirmed live that pnpm's default strict,
 * non-hoisted install never creates a root `node_modules/.bin/tsx` at all,
 * since `tsx` is declared as each of those two workspaces' OWN
 * devDependency, not the workspace root's.
 */
function spawnApp(name, tsxBin, entry, extraEnv = {}) {
  const child = spawn(tsxBin, [entry], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code, signal) => {
    console.log(`[entrypoint] ${name} exited (code=${code}, signal=${signal})`);
  });
  return child;
}

async function main() {
  await runMigrationsIfEnabled();

  const proxyPort = process.env.PORT ?? "8080";
  const apiPort = process.env.API_PORT ?? "3001";
  const realtimePort = process.env.REALTIME_PORT ?? "1234";

  const children = [
    spawnApp("api", "apps/api/node_modules/.bin/tsx", "apps/api/dist/index.js", { PORT: apiPort }),
    spawnApp(
      "realtime",
      "apps/realtime/node_modules/.bin/tsx",
      "apps/realtime/dist/index.js",
      { REALTIME_PORT: realtimePort },
    ),
    // The proxy is plain JS with a genuinely separate, non-workspace
    // `node_modules` (see `infra/docker/proxy/package.json`'s header
    // comment) — plain `node`, no `tsx` needed.
    spawn("node", ["infra/docker/proxy/proxy.mjs"], {
      stdio: "inherit",
      env: { ...process.env, PORT: proxyPort, API_PORT: apiPort, REALTIME_PORT: realtimePort },
    }),
  ];

  let shuttingDown = false;

  function shutdown(exitCode) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    // Give children a moment to exit cleanly before this process itself
    // exits — Docker's own stop-timeout (default 10s) is the backstop if
    // any of them ignores SIGTERM outright.
    setTimeout(() => process.exit(exitCode), 500);
  }

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      console.log(`[entrypoint] received ${signal}, shutting down...`);
      shutdown(0);
    });
  }

  // Whichever child exits FIRST — whether it crashed or exited cleanly on
  // its own — is treated as "this container is no longer healthy": kill
  // the rest and exit non-zero so the host's restart policy recreates the
  // whole container. None of these three processes is expected to exit on
  // its own during normal operation, so there is no "acceptable" case to
  // special-case here.
  for (const child of children) {
    child.on("exit", (code) => {
      if (!shuttingDown) {
        console.error("[entrypoint] a child process exited unexpectedly — tearing down the container.");
        shutdown(code && code !== 0 ? code : 1);
      }
    });
  }
}

main().catch((err) => {
  console.error("[entrypoint] fatal:", err);
  process.exit(1);
});
