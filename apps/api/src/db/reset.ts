import { fileURLToPath } from "node:url";

import { sql } from "kysely";

import { closeDb, db } from "../db.js";
import { migrateToLatest } from "./migrate.js";

/**
 * Local-dev convenience: drops every table (by dropping and recreating the
 * `public` schema, rather than tracking table-drop order by hand) and then
 * re-runs every migration from scratch. Never run this against a database
 * that holds anything worth keeping.
 */
export async function resetDatabase(): Promise<void> {
  console.log("[db:reset] dropping schema public...");
  await sql`drop schema public cascade`.execute(db);
  await sql`create schema public`.execute(db);

  console.log("[db:reset] re-running migrations...");
  await migrateToLatest();
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  resetDatabase()
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
