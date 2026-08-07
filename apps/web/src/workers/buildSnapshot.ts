// Builds the plain `SolverSnapshot` `@scm/solver` needs from the *live*
// `@scm/ydoc` document — the one place in this directory that touches
// `@scm/ydoc` at all.
//
// Deliberately `listNodes`/`listEdges` — the WHOLE-document accessors —
// never `listNodesByContainer`/`listEdgesByContainer`. The connected-
// components partitioning this snapshot feeds into (`partition.ts`) must
// operate on the real underlying graph, not a single container's slice of
// it: an outpost container is a UI/rendering concept (Job 013's boundary
// node + derived ports, `apps/web/src/canvas/outposts/visibleGraph.ts`),
// not a structural partition of `EdgeRecord`s. A boundary-crossing
// connection is, underneath, an ordinary `EdgeRecord` naming two real node
// ids directly — see `jobs/013-outposts.md`'s Handoff notes, "The
// boundary-crossing-edge design decision" — so building this snapshot from
// a container-scoped read would silently truncate the real graph at
// whichever outpost boundary the current view happens to be inside, which
// would make `partition.ts`'s components (and therefore the dirty-subgraph
// cache) wrong in exactly the way this job's spec calls out as the single
// biggest risk.
import { defaultGameData, type GameData } from "@scm/gamedata";
import { listContainers, listEdges, listNodes, type SfmDocument } from "@scm/ydoc";
import type { SolverEdge, SolverMode, SolverNode, SolverSnapshot } from "@scm/solver";

import { collapseBlueprints, type BlueprintDisplayInfo } from "./blueprintCollapse";
import { computeSplurgerPassthroughEdges } from "./splurgerPassthrough";

/**
 * Only `kind: "recipe"` nodes are included — the only node kind
 * `@scm/solver`'s `SolverNode` can represent (see `packages/solver/src/
 * snapshot.ts`'s header and Job 017's Handoff notes: "whichever later job
 * adds one of those [other] kinds to the canvas needs to extend
 * `snapshot.ts` first"). An edge is included only if BOTH endpoints are
 * recipe nodes — an edge touching a node kind the solver can't represent
 * (an outpost boundary node, `DevNodeTools`' `kind: "debug"` node, ...) is
 * silently excluded rather than passed through with a dangling reference
 * the solver has never heard of.
 *
 * Job 024 (`kind: "splurger"`, no recipe/machine) is the one deliberate
 * EXCEPTION to "silently excluded": a Splurger never becomes a `SolverNode`
 * itself, but its incident edges are first rewritten by
 * `splurgerPassthrough.ts`'s `computeSplurgerPassthroughEdges` into direct
 * recipe-to-recipe `SolverEdge`s (carrying the Splurger's own priority-tier
 * assignment) BEFORE the "both endpoints must be a recipe node" filter runs
 * — so a real Splurger sitting between two real recipe nodes participates
 * in the solve as if it weren't there, with zero changes to `@scm/solver`
 * itself. See that module's header comment for exactly which wiring shapes
 * this can and can't represent, and jobs/024-priority-nodes.md's Handoff
 * notes for the full design writeup.
 */
export function buildSolverSnapshot(sfmDoc: SfmDocument): SolverSnapshot {
  const allNodes = listNodes(sfmDoc);
  const recipeNodes = allNodes.filter((node) => node.kind === "recipe");
  const recipeNodeIds = new Set(recipeNodes.map((node) => node.id));
  const splurgerNodes = allNodes.filter((node) => node.kind === "splurger");

  const nodes: SolverNode[] = recipeNodes.map((node) => ({
    id: node.id,
    // `NodeRecord.recipe`/`.machine` are nullable (Job 007's schema) — a
    // recipe node with either unset (mid-creation, or corrupt data) maps to
    // `""`, which `@scm/solver`'s `buildNodeProfile` treats as an unknown
    // recipe/machine and reports via `NodeSolveResult.issues` rather than
    // throwing (Job 017's "never throws" guarantee — see that job's
    // Handoff notes). This keeps one bad node from crashing the whole solve.
    recipe: node.recipe ?? "",
    machine: node.machine ?? "",
    purity: node.purity,
    limit: node.limit,
    limitMode: node.limitMode,
    clock: node.clock,
    shards: node.shards,
  }));

  const allEdges = listEdges(sfmDoc);

  const directEdges = allEdges
    .filter((edge) => recipeNodeIds.has(edge.fromNode) && recipeNodeIds.has(edge.toNode))
    .map((edge) => ({
      id: edge.id,
      part: edge.part,
      fromNode: edge.fromNode,
      fromPort: edge.fromPort,
      toNode: edge.toNode,
      toPort: edge.toPort,
    }));

  // Splurger pass-through rewrite (Job 024). A synthetic edge that still
  // lands on a non-recipe node (a chained Splurger — see
  // `splurgerPassthrough.ts`'s header on why that's not resolved here) is
  // filtered out by the same `recipeNodeIds` check `directEdges` uses above,
  // never passed through with a dangling reference.
  const passthrough = computeSplurgerPassthroughEdges(splurgerNodes, allEdges);
  const splurgerEdges = passthrough.edges
    .filter((edge) => recipeNodeIds.has(edge.fromNode) && recipeNodeIds.has(edge.toNode))
    .map((edge) => ({
      id: edge.id,
      part: edge.part,
      fromNode: edge.fromNode,
      fromPort: edge.fromPort,
      toNode: edge.toNode,
      toPort: edge.toPort,
      ...(edge.priorityTier ? { priorityTier: edge.priorityTier } : {}),
    }));

  const edges: SolverEdge[] = [...directEdges, ...splurgerEdges];

  return { nodes, edges };
}

/**
 * Job 026 (Blueprints, PLAN.md §10.3): `buildSolverSnapshot`'s raw,
 * container-agnostic flattening, THEN — Basic/Full mode only, and only when
 * the document actually has a `kind: "blueprint"` container — collapsing
 * each top-level blueprint's internal recipe subgraph into one compound
 * `SolverNode` via `blueprintCollapse.ts`'s `collapseBlueprints`. See that
 * module's header for the full "how §10.3 was resolved" writeup; this
 * function is just the one new call site in the existing snapshot-building
 * pipeline. Returns the (possibly collapsed) snapshot plus the metadata
 * `useSolver.ts` needs to expand the compound's solved result back into
 * real, correctly-scaled per-internal-node/edge entries for display —
 * `blueprints` is `[]` (and `snapshot` identical to `buildSolverSnapshot`'s
 * own output) for every document with no blueprint container at all, i.e.
 * zero behavior change for every project that predates this job.
 */
export function buildSolverSnapshotWithBlueprints(
  sfmDoc: SfmDocument,
  mode: SolverMode,
  gameData: GameData = defaultGameData,
): { snapshot: SolverSnapshot; blueprints: readonly BlueprintDisplayInfo[]; skippedNestedBlueprintIds: readonly string[] } {
  const rawSnapshot = buildSolverSnapshot(sfmDoc);
  const containers = listContainers(sfmDoc);
  if (!containers.some((c) => c.kind === "blueprint")) {
    return { snapshot: rawSnapshot, blueprints: [], skippedNestedBlueprintIds: [] };
  }
  const nodes = listNodes(sfmDoc);
  return collapseBlueprints(containers, nodes, rawSnapshot, mode, gameData);
}
