/* eslint-disable @typescript-eslint/no-explicit-any -- see 0001_users.ts */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("projects")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // URL-friendly id, e.g. /p/k3n9wq2
    .addColumn("short_id", "text", (col) => col.notNull().unique())
    .addColumn("owner_id", "uuid", (col) => col.notNull().references("users.id"))
    .addColumn("title", "text", (col) => col.notNull().defaultTo("My Factory"))
    .addColumn("visibility", "text", (col) => col.notNull().defaultTo("private"))
    // Which game_data.json revision this project targets.
    .addColumn("game_data_version", "text", (col) => col.notNull())
    // Solver mode, multipliers, grid, number formats.
    .addColumn("doc_settings", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    // Soft delete.
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint("projects_visibility_check", sql`visibility in ('private','link','public')`)
    .execute();

  await db.schema
    .createIndex("projects_owner_id_index")
    .on("projects")
    .column("owner_id")
    .where(sql.ref("deleted_at"), "is", null)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("projects").execute();
}
