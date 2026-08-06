/* eslint-disable @typescript-eslint/no-explicit-any -- see 0001_users.ts */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("project_invites")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("project_id", "uuid", (col) =>
      col.notNull().references("projects.id").onDelete("cascade"),
    )
    .addColumn("token_hash", "bytea", (col) => col.notNull().unique())
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("expires_at", "timestamptz")
    .addColumn("max_uses", "integer")
    .addColumn("uses", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_by", "uuid", (col) => col.notNull().references("users.id"))
    .addCheckConstraint("project_invites_role_check", sql`role in ('editor','viewer')`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("project_invites").execute();
}
