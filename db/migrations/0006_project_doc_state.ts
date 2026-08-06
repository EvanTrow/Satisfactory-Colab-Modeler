/* eslint-disable @typescript-eslint/no-explicit-any -- see 0001_users.ts */
import { type Kysely, sql } from "kysely";

// PLAN.md §4 "Canvas state: snapshot + incremental log" — the compacted
// snapshot half of the split. One row per project; loading a document reads
// this row plus every `project_doc_updates` row with `id > seq` (Job 015).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("project_doc_state")
    .addColumn("project_id", "uuid", (col) =>
      col.primaryKey().references("projects.id").onDelete("cascade"),
    )
    // Y.encodeStateAsUpdate(doc)
    .addColumn("ydoc", "bytea", (col) => col.notNull())
    // Lets clients sync a delta instead of the whole doc.
    .addColumn("state_vector", "bytea", (col) => col.notNull())
    // Highest project_doc_updates.id folded into this snapshot.
    .addColumn("seq", "bigint", (col) => col.notNull())
    .addColumn("compacted_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("project_doc_state").execute();
}
