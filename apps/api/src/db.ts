import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";

import type { Database } from "@scm/db";

// apps/api has no .env of its own. Local dev reads the same DATABASE_URL
// that `infra/docker-compose.yml`'s Postgres container is configured with,
// from `infra/.env` (copied from `infra/.env.example` — see the repo
// README's "Dev setup" section). `dotenv` never overrides variables that
// are already set in the environment, and silently no-ops if the file
// doesn't exist (e.g. in production/CI, where DATABASE_URL is provided
// directly), so this is safe to call unconditionally.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../infra/.env") });

// Matches infra/.env.example's DATABASE_URL exactly, so `pnpm dev`/tests
// work against `docker compose -f infra/docker-compose.yml up -d` even
// before anyone copies infra/.env.example to infra/.env.
const DEFAULT_DATABASE_URL = "postgresql://scm:scm@localhost:5432/scm";

export const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

const postgresClient = postgres(DATABASE_URL, {
  // postgres.js logs every server NOTICE (e.g. "drop cascades to table x")
  // to the console by default, which is expected noise from `db:reset`'s
  // `drop schema public cascade` and not worth surfacing as if it were a
  // warning.
  onnotice: () => {},
});

/**
 * The shared Kysely connection, typed against `@scm/db`'s `Database`
 * interface (which mirrors the migrations in `db/migrations/` exactly).
 * Import this to run typed queries against `users`, `sessions`,
 * `projects`, `project_members`, and `project_invites`.
 */
export const db = new Kysely<Database>({
  dialect: new PostgresJSDialect({ postgres: postgresClient }),
});

/**
 * Closes the underlying `postgres.js` connection pool. Call this when a
 * short-lived process using `db` (a script, a test suite) is done —
 * omitting it leaves the process hanging on open sockets.
 */
export async function closeDb(): Promise<void> {
  await db.destroy();
}

export type { Database } from "@scm/db";
