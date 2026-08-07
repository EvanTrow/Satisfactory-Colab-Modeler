// Job 020: the real Kysely/Postgres connection setup moved to
// `packages/doc-storage/src/db.ts` (a real shared workspace package, since
// `apps/realtime` needs the exact same connection/persistence logic — see
// that package's `index.ts` header comment for the full reasoning). This
// file is now a thin re-export so every other file in `apps/api` that does
// `import { db } from "../db.js"` (or `"./db.js"`) keeps working completely
// unchanged — only this file's *contents* moved, not its import path.
export { closeDb, DATABASE_URL, db } from "@scm/doc-storage";
export type { Database } from "@scm/doc-storage";
