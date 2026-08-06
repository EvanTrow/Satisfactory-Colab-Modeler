/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely's `Migration`
 * interface (`kysely/migration`) declares `up`/`down` as
 * `(db: Kysely<any>) => Promise<void>`; matching that exactly, per Kysely's
 * own migration docs, is what makes these files assignable to it. */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("discord_id", "text", (col) => col.notNull().unique())
    .addColumn("username", "text", (col) => col.notNull())
    .addColumn("global_name", "text")
    .addColumn("avatar_hash", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("last_seen_at", "timestamptz")
    .execute();

  // Discord access/refresh tokens are deliberately NOT stored: we need
  // identity only at login, so discarding them removes an
  // encryption-at-rest obligation entirely. See PLAN.md section 4.
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("users").execute();
}
