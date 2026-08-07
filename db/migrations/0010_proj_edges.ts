/* eslint-disable @typescript-eslint/no-explicit-any -- see 0001_users.ts */
import { type Kysely, sql } from "kysely";

// PLAN.md §4 "Relational projection (read-only, Phase 6)" — Job 025.
// Companion to `proj_nodes` (0009); see that migration's header comment for
// the shared context. Column list matches PLAN.md §4's `proj_edges` SQL
// sample exactly — no additions needed here (edges carry no rational-valued
// fields, so the limit/clock exact/approx pattern doesn't apply).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("proj_edges")
    .addColumn("project_id", "uuid", (col) =>
      col.notNull().references("projects.id").onDelete("cascade"),
    )
    .addColumn("edge_id", "text", (col) => col.notNull())
    .addColumn("part", "text", (col) => col.notNull())
    .addColumn("from_node", "text", (col) => col.notNull())
    .addColumn("from_port", "text", (col) => col.notNull())
    .addColumn("to_node", "text", (col) => col.notNull())
    .addColumn("to_port", "text", (col) => col.notNull())
    .addColumn("waypoints", "jsonb", (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addPrimaryKeyConstraint("proj_edges_pkey", ["project_id", "edge_id"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("proj_edges").execute();
}
