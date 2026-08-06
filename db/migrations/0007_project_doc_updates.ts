/* eslint-disable @typescript-eslint/no-explicit-any -- see 0001_users.ts */
import { type Kysely, sql } from "kysely";

// PLAN.md §4 "Canvas state: snapshot + incremental log" — the append-only
// log half of the split. Written on every debounced flush from the client
// (Job 015); cheap, never rewrites the document. A background/inline
// compaction folds these rows into `project_doc_state` once there are more
// than ~200 for a project, then deletes the folded rows.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("project_doc_updates")
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.notNull().references("projects.id").onDelete("cascade"),
    )
    // A Yjs update blob.
    .addColumn("update", "bytea", (col) => col.notNull())
    .addColumn("actor_user_id", "uuid", (col) => col.references("users.id"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("project_doc_updates_project_id_id_index")
    .on("project_doc_updates")
    .columns(["project_id", "id"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("project_doc_updates").execute();
}
