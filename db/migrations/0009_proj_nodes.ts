/* eslint-disable @typescript-eslint/no-explicit-any -- see 0001_users.ts */
import { type Kysely } from "kysely";

// PLAN.md §4 "Relational projection (read-only, Phase 6)" — Job 025.
// Materialized from the CRDT on a debounce so the server can query
// factories without instantiating Yjs. Never written by the client; never a
// source of truth (the Yjs document at `project_doc_state`/
// `project_doc_updates` remains the only source of truth for canvas state).
//
// Column list matches PLAN.md §4's `proj_nodes` SQL sample exactly, with one
// deliberate addition: `clock_approx double precision`. PLAN.md's own sample
// DDL only lists `clock_exact` (no `clock_approx`), but the same section's
// "Rational storage" callout and this job's own acceptance criteria treat
// `limit`/`clock` symmetrically ("limit_exact/clock_exact store the
// canonical... limit_approx/clock_approx store a double precision
// companion... derived from, never computed independently of, the exact
// value"). Omitting `clock_approx` would make clock un-sortable/un-filterable
// the same way `limit_approx` makes limit sortable/filterable, which reads as
// an oversight in the sample SQL rather than an intentional asymmetry — see
// jobs/025-relational-projection.md's Handoff notes for the full reasoning.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("proj_nodes")
    .addColumn("project_id", "uuid", (col) =>
      col.notNull().references("projects.id").onDelete("cascade"),
    )
    .addColumn("node_id", "text", (col) => col.notNull())
    .addColumn("container_id", "text", (col) => col.notNull())
    // 'recipe' | 'splurger' | 'storage' | 'outpost' | ... — kept as `text`,
    // not a check constraint, matching @scm/ydoc's own open `NodeKind` type
    // (PLAN.md's ellipsis: more kinds are expected without a migration).
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("recipe_name", "text")
    // Resolved MultiMachine variant name, e.g. 'Miner Mk.2' — see
    // projection.ts's header comment for why this is a straight copy of
    // NodeRecord.machine, not a re-resolution via @scm/gamedata.
    .addColumn("machine_name", "text")
    .addColumn("pos_x", "double precision")
    .addColumn("pos_y", "double precision")
    // Canonical "n/d" string — the lossless source. Never reformat/re-derive.
    .addColumn("limit_exact", "text")
    // double precision, for sorting/filtering only — derived FROM limit_exact
    // via @scm/rational's parseRational + toApproximateNumber, never computed
    // independently of it.
    .addColumn("limit_approx", "double precision")
    .addColumn("clock_exact", "text")
    .addColumn("clock_approx", "double precision")
    .addColumn("shards", "int2")
    .addColumn("purity", "text")
    .addColumn("belt_tier", "text")
    .addColumn("storage_mode", "text")
    .addPrimaryKeyConstraint("proj_nodes_pkey", ["project_id", "node_id"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("proj_nodes").execute();
}
