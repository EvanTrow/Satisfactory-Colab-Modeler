import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FileMigrationProvider, Migrator } from "kysely/migration";

import { closeDb, db } from "../db.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// apps/api/src/db -> apps/api/src -> apps/api -> apps -> <repo root>
const MIGRATIONS_DIR = path.resolve(here, "../../../../db/migrations");

function createMigrator(): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATIONS_DIR,
      // Node's dynamic `import()` rejects bare Windows drive-letter paths
      // outright (it parses the "D:" in "D:\git\...\0001_users.ts" as a URL
      // scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME) — the default
      // FileMigrationProvider behavior (`import(filePath)` with the raw fs
      // path) breaks on Windows dev machines. Always go through a proper
      // `file://` URL instead, which works identically on every platform.
      import: (modulePath: string) => import(pathToFileURL(modulePath).href),
    }),
  });
}

/** Runs every migration in `db/migrations/` that hasn't been applied yet. */
export async function migrateToLatest(): Promise<void> {
  const migrator = createMigrator();
  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === "Success") {
      console.log(`[db:migrate] applied ${result.migrationName}`);
    } else if (result.status === "Error") {
      console.error(`[db:migrate] FAILED ${result.migrationName}`);
    }
  }

  if (error) {
    console.error("[db:migrate] migration run failed:", error);
    throw error instanceof Error ? error : new Error(String(error));
  }

  if ((results ?? []).length === 0) {
    console.log("[db:migrate] already up to date, nothing to do");
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  migrateToLatest()
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
