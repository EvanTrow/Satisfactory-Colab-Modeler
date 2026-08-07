// Job 020: the Kysely/Postgres connection setup, promoted here (verbatim in
// substance) from `apps/api/src/db.ts` — see this package's `index.ts`
// header comment for why. `apps/api` re-exports this module unchanged (so
// none of its other files, which all `import { db } from "../db.js"`, had
// to change); `apps/realtime` imports it directly. Both processes get their
// own singleton connection pool (one per process, exactly as before — Node
// module caching means each process's own import of `@scm/doc-storage`
// creates exactly one `postgres()` client, same as today).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";

import type { Database } from "@scm/db";

// `packages/doc-storage/src/db.ts` is the same depth below the repo root as
// `apps/api/src/db.ts` was (`packages/doc-storage/src` vs. `apps/api/src`,
// both three path segments deep), so the original "../../../infra/.env"
// relative path still resolves correctly without adjustment.
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
 * interface. Import this to run typed queries against any table in
 * `db/migrations/` — `users`, `sessions`, `projects`, `project_members`,
 * `project_doc_state`, `project_doc_updates`, `project_versions`, etc.
 */
export const db = new Kysely<Database>({
  dialect: new PostgresJSDialect({ postgres: postgresClient }),
});

/**
 * Closes the underlying `postgres.js` connection pool. Call this when a
 * short-lived process using `db` (a script, a test suite) is done — see
 * `apps/api/src/db.ts`'s original doc comment (preserved verbatim below)
 * for why this forces a close after a 5s timeout rather than draining
 * gracefully forever.
 */
export async function closeDb(): Promise<void> {
  await postgresClient.end({ timeout: 5 });
}

export type { Database } from "@scm/db";
