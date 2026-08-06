/* eslint-disable @typescript-eslint/no-explicit-any -- see 0001_users.ts */
import { type Kysely, sql } from "kysely";

// PLAN.md §4 "Named/auto version history for restore." Only the table is
// needed by Job 015 — an insert path is wired up (docStorage.ts's
// `createProjectVersion`) so Job 016 has something to build restore UI on
// top of, but restore itself is explicitly out of this job's scope.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("project_versions")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("project_id", "uuid", (col) =>
      col.notNull().references("projects.id").onDelete("cascade"),
    )
    .addColumn("ydoc", "bytea", (col) => col.notNull())
    .addColumn("label", "text")
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("created_by", "uuid", (col) => col.references("users.id"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "project_versions_kind_check",
      sql`kind in ('auto','manual','import','pre_restore')`,
    )
    .execute();

  await db.schema
    .createIndex("project_versions_project_id_created_at_index")
    .on("project_versions")
    .columns(["project_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("project_versions").execute();
}
