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
import { listEdges, listNodes, type SfmDocument } from "@scm/ydoc";
import type { SolverEdge, SolverNode, SolverSnapshot } from "@scm/solver";

/**
 * Only `kind: "recipe"` nodes are included — the only node kind
 * `@scm/solver`'s `SolverNode` can represent (see `packages/solver/src/
 * snapshot.ts`'s header and Job 017's Handoff notes: "whichever later job
 * adds one of those [other] kinds to the canvas needs to extend
 * `snapshot.ts` first"). An edge is included only if BOTH endpoints are
 * recipe nodes — an edge touching a node kind the solver can't represent
 * (an outpost boundary node, a future splurger/storage node, `DevNodeTools`'
 * `kind: "debug"` node, ...) is silently excluded rather than passed
 * through with a dangling reference the solver has never heard of.
 */
export function buildSolverSnapshot(sfmDoc: SfmDocument): SolverSnapshot {
  const recipeNodes = listNodes(sfmDoc).filter((node) => node.kind === "recipe");
  const recipeNodeIds = new Set(recipeNodes.map((node) => node.id));

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

  const edges: SolverEdge[] = listEdges(sfmDoc)
    .filter((edge) => recipeNodeIds.has(edge.fromNode) && recipeNodeIds.has(edge.toNode))
    .map((edge) => ({
      id: edge.id,
      part: edge.part,
      fromNode: edge.fromNode,
      fromPort: edge.fromPort,
      toNode: edge.toNode,
      toPort: edge.toPort,
    }));

  return { nodes, edges };
}
