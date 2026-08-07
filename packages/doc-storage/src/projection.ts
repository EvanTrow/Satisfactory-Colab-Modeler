// Job 025: the relational projection (`proj_nodes`/`proj_edges`) described
// in PLAN.md §4 "Relational projection (read-only, Phase 6)" —
// "Materialized from the CRDT on a debounce so the server can query
// factories without instantiating Yjs... Never written by the client; never
// a source of truth."
//
// *** Where this is hooked in, and why ***
//
// `docStorage.ts`'s `appendUpdate` is the one function every doc mutation
// flows through today, regardless of transport: `apps/realtime`'s
// `onStoreDocument` (Hocuspocus's own debounced flush — the live
// multiplayer path virtually all real edits take, per Job 020) and the
// older REST push route in `apps/api` (still present, effectively unused by
// the client since Job 020, but not dead — nothing stops a future caller
// from using it) both call it, and neither reimplements the merge algorithm.
// `appendUpdate` calls `materializeProjection` right after its own insert
// succeeds (see that function, below) — this is deliberately *not* a new
// trigger mechanism: it rides the exact debounce Hocuspocus/the REST push
// route already provide (their own `debounce`/`maxDebounce`, or the
// pre-Job-020 client-side debounce timer), rather than adding a second timer
// or polling loop. The alternative this job considered — hooking into
// `apps/realtime/src/server.ts`'s `onStoreDocument` directly instead — was
// rejected because it would silently miss the REST push route (and any
// future caller of `appendUpdate` that isn't `onStoreDocument`); hooking
// the shared function is the same reasoning Job 020 already used to justify
// promoting `appendUpdate` itself into this package in the first place.
//
// Materialization failure is caught and logged inside `appendUpdate`, never
// thrown — by the time it runs, the actual source of truth (the Yjs update)
// is already durably written to `project_doc_updates`. A missed
// materialization just means the projection is stale until the next
// successful debounced flush, which is consistent with "this table is a
// read-only, best-effort cache of the CRDT," not a partial-write hazard.
//
// *** Why this is a full replace-on-materialize, not a diff-based upsert ***
//
// PLAN.md §2: node counts run "tens to low hundreds per outpost." At that
// scale, deleting every `proj_nodes`/`proj_edges` row for a project and
// bulk-inserting the current set — inside one transaction, so a concurrent
// reader never observes a torn (all-deleted, nothing-yet-inserted) state —
// is simpler and provably staleness-free: there is no bookkeeping to get
// wrong (no "did I remember to delete the row for that node" tracking), so
// a deleted node/edge simply isn't in the next materialization's insert set
// and is gone. A diff-based upsert+delete would need to independently track
// "what's currently in proj_nodes for this project" and reconcile it against
// "what's currently in the live doc," which is strictly more bookkeeping for
// no correctness benefit at this scale.
//
// *** Rational storage (PLAN.md §4's "Rational storage" callout) ***
//
// `NodeRecord.limit`/`.clock` are already `@scm/rational` canonical `"n/d"`
// strings (or `null`) as of Job 010 — see that job's own Handoff notes
// ("Both fields are `@scm/rational` canonical n/d strings... or null").
// `limit_exact`/`clock_exact` are therefore a straight copy-through, never
// reformatted. `limit_approx`/`clock_approx` are derived FROM that exact
// string via `parseRational` + `toApproximateNumber` — `toApproximateNumber`
// is `@scm/rational`'s own "ONE deliberate floating-point boundary," so
// routing through it here (rather than, say, `Number(fractionString)`,
// which would mishandle a bare "n/d" string) keeps this module's one
// intentional precision loss auditable at the same single boundary every
// other part of this codebase already uses.
//
// *** MultiMachine variant resolution into `machine_name` ***
//
// `NodeRecord.machine` is NOT the family name ("Miner") — Job 009/010's node
// creation path (`apps/web/src/panels/recipeChooser/filters.ts`'s
// `buildNodeInputForRecipe`) already resolves a MultiMachine recipe against
// `@scm/gamedata`'s `resolveMachine`/`defaultVariant`/`findVariant` at
// node-creation time and stores the *resolved concrete variant's own
// `Machine.name`* (e.g. "Miner Mk.2") directly on the node. So
// `machine_name` here is a straight copy of `NodeRecord.machine` — calling
// `resolveMachine` a second time here would be redundant (and would need a
// `@scm/gamedata`/game-data-version dependency this package doesn't
// otherwise need): the resolution already happened once, at the only point
// it needed to, and its result is what's already sitting in the CRDT.
// `purity` is likewise a straight copy of `NodeRecord.purity` (already the
// lowercase 'impure'|'normal'|'pure' string PLAN.md's `proj_nodes.purity`
// column wants).
import { sql } from "kysely";
import type { NewProjEdge, NewProjNode } from "@scm/db";
import { parseRational, toApproximateNumber } from "@scm/rational";
import { createDocument, listEdges, listNodes, type EdgeRecord, type NodeRecord } from "@scm/ydoc";

import { db } from "./db.js";
import { loadProjectDoc } from "./docStorage.js";

/**
 * Derives a `double precision` approximation from a canonical `"n/d"`
 * string, routing through `@scm/rational`'s own float boundary
 * (`parseRational` + `toApproximateNumber`) rather than any independent
 * computation — this is the literal mechanism behind PLAN.md's "never
 * compute from the approximate column" rule (the rule is about never
 * treating the approx column as authoritative once written; this function
 * is what makes sure it's never even *produced* independently of the exact
 * value in the first place).
 *
 * Returns `null` for a `null` input, and — defensively — for a string that
 * fails to parse. Every known writer of `NodeRecord.limit`/`.clock` goes
 * through `toFractionString` (Job 010), so a parse failure here would mean
 * corrupt/foreign data already got past `@scm/ydoc`'s schema; that should
 * never happen, but a single bad field must not take down the whole
 * materialization pass for a project.
 */
export function deriveApprox(exact: string | null): number | null {
  if (exact === null) return null;
  try {
    return toApproximateNumber(parseRational(exact));
  } catch (err) {
    console.error(`[projection] failed to parse rational string "${exact}" while deriving an approx column`, err);
    return null;
  }
}

/** Maps one `NodeRecord` to its `proj_nodes` row shape. Pure — no I/O. */
export function toProjNodeRow(projectId: string, node: NodeRecord): NewProjNode {
  return {
    project_id: projectId,
    node_id: node.id,
    container_id: node.containerId,
    kind: node.kind,
    recipe_name: node.recipe,
    machine_name: node.machine,
    pos_x: node.x,
    pos_y: node.y,
    limit_exact: node.limit,
    limit_approx: deriveApprox(node.limit),
    clock_exact: node.clock,
    clock_approx: deriveApprox(node.clock),
    shards: node.shards,
    purity: node.purity,
    belt_tier: node.beltTier,
    storage_mode: node.storageMode,
  };
}

/**
 * Maps one `EdgeRecord` to its `proj_edges` row shape. Pure — no I/O.
 * `waypoints` is written as an explicit `::jsonb`-cast text literal (via
 * Kysely's `sql` tag) rather than handing the plain array to the
 * `postgres.js` driver directly — `PostgresJSConnection.executeQuery` (see
 * `kysely-postgres-js`) calls `unsafe()` with raw parameters, which
 * serializes a bare JS array as a Postgres `ARRAY` literal, not JSON; an
 * explicit cast sidesteps that ambiguity entirely.
 */
export function toProjEdgeRow(projectId: string, edge: EdgeRecord): NewProjEdge {
  return {
    project_id: projectId,
    edge_id: edge.id,
    part: edge.part,
    from_node: edge.fromNode,
    from_port: edge.fromPort,
    to_node: edge.toNode,
    to_port: edge.toPort,
    waypoints: sql`${JSON.stringify(edge.waypoints)}::jsonb`,
  };
}

export interface MaterializeResult {
  projectId: string;
  nodeCount: number;
  edgeCount: number;
}

/**
 * Loads `projectId`'s current merged Yjs doc state (snapshot + log, via
 * `loadProjectDoc` — the same merge `docStorage.ts` itself uses) and
 * replaces that project's `proj_nodes`/`proj_edges` rows with exactly the
 * nodes/edges the live document currently has. See this module's header
 * comment for why a full replace (rather than a diff-based upsert+delete) is
 * the right call at this app's documented node-count scale, and why this is
 * always correct for deletions: a node/edge removed from the live doc simply
 * isn't in the next call's insert set, so it's gone from the projection too
 * — there is no "did I remember to delete its row" bookkeeping to get wrong.
 *
 * Runs inside a single transaction so a concurrent reader of `proj_nodes`/
 * `proj_edges` never observes a torn state (rows deleted, new ones not yet
 * inserted).
 */
export async function materializeProjection(projectId: string): Promise<MaterializeResult> {
  const { doc } = await loadProjectDoc(projectId);
  const sfmDoc = createDocument({ doc });

  const nodeRows = listNodes(sfmDoc).map((node) => toProjNodeRow(projectId, node));
  const edgeRows = listEdges(sfmDoc).map((edge) => toProjEdgeRow(projectId, edge));

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("proj_nodes").where("project_id", "=", projectId).execute();
    await trx.deleteFrom("proj_edges").where("project_id", "=", projectId).execute();

    // Kysely's `.values([])` on an empty array is either a no-op-shaped
    // error or an invalid `VALUES ()` clause depending on dialect/version —
    // guard explicitly rather than relying on that. An empty project (no
    // nodes/edges at all, or everything just got deleted) is exactly the
    // case where "nothing left to insert after the delete above" is the
    // correct, intended outcome.
    if (nodeRows.length > 0) {
      await trx.insertInto("proj_nodes").values(nodeRows).execute();
    }
    if (edgeRows.length > 0) {
      await trx.insertInto("proj_edges").values(edgeRows).execute();
    }
  });

  return { projectId, nodeCount: nodeRows.length, edgeCount: edgeRows.length };
}
