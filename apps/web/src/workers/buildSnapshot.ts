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

import { computeSinkConsumerNodes } from "./sinkPassthrough";
import { computeSplurgerPassthroughEdges } from "./splurgerPassthrough";
import { computeStorageBufferNodes } from "./storagePassthrough";

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
 *
 * `kind: "sink"`/`"depot"` (AWESOME Sink/Dimensional Depot Uploader) and
 * `kind: "storage"` (Storage Container) get the same "rewrite before the
 * filter runs" treatment, via `sinkPassthrough.ts`/`storagePassthrough.ts`
 * — except neither erases itself into a direct edge between two REAL
 * nodes; each synthesizes its own tiny single-part `syntheticCopyBasis`
 * compound node(s) (an escape hatch for a node with no real gamedata
 * recipe) to stand in for what it consumes/produces, since none of these
 * three kinds has a fixed recipe ratio the way a Splurger's passthrough
 * rewrite can lean on. See those two modules' headers for why.
 *
 * Outpost I/O rework: the Splurger/outpost-input/outpost-output
 * rewrite runs FIRST, against the raw edges, and its OUTPUT (not the raw
 * edges) is what Sink/Storage/Depot's own rewrite sees. This ordering
 * matters for a chain like "producer -> outpost Outputs node -> AWESOME
 * Sink": the outpost rewrite alone turns this into "producer -> Sink", but
 * a Sink isn't a `recipe` node, so that synthetic edge would still be
 * dropped by the plain recipe-to-recipe filter; running Sink's OWN rewrite
 * on this ALREADY-composed edge (instead of the original "Outputs node ->
 * Sink" one, whose `fromNode` isn't a recipe node either) is what lets it
 * correctly see `producer` as the real source and mint its usual synthetic
 * consumer node from it. Without this ordering, a Splurger/outpost pass-
 * through node feeding directly into a Sink/Storage/Depot silently vanished
 * from the solve entirely (both sides' independent rewrites individually
 * correct, but composing to nothing) — confirmed live as "only 1ppm flows
 * unless a limit is set."
 */
export function buildSolverSnapshot(sfmDoc: SfmDocument): SolverSnapshot {
  const allNodes = listNodes(sfmDoc);
  const recipeNodes = allNodes.filter((node) => node.kind === "recipe");
  const recipeNodeIds = new Set(recipeNodes.map((node) => node.id));
  const splurgerNodes = allNodes.filter((node) => node.kind === "splurger");
  const sinkNodes = allNodes.filter((node) => node.kind === "sink" || node.kind === "depot");
  const storageNodes = allNodes.filter((node) => node.kind === "storage");
  // Outpost I/O rework: the two locked pass-through nodes every outpost
  // container gets (`canvas/outposts/io.ts`) are erased into direct
  // recipe-to-recipe edges the exact same way a Splurger is —
  // `computeSplurgerPassthroughEdges` is already fully generic (nothing in
  // it is actually Splurger-specific), so it's reused as-is rather than
  // duplicating a near-identical module. See `canvas/outposts/io.ts`'s
  // header for the full design.
  const outpostIoNodes = allNodes.filter((node) => node.kind === "outpost-input" || node.kind === "outpost-output");

  const recipeSolverNodes: SolverNode[] = recipeNodes.map((node) => ({
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

  // Splurger + outpost-input/outpost-output pass-through rewrite (Job 024,
  // Outpost I/O rework) — run FIRST, see this function's own
  // header comment for why. Every edge incident to one of these nodes is
  // erased from the pool entirely (whether it produced a synthetic
  // replacement or was dangling/unsupported — see `splurgerPassthrough.ts`'s
  // header) and, where a replacement exists, that takes its place instead.
  const passthroughNodeIds = new Set([...splurgerNodes, ...outpostIoNodes].map((node) => node.id));
  const splurgerPassthrough = computeSplurgerPassthroughEdges(splurgerNodes, allEdges);
  const outpostIoPassthrough = computeSplurgerPassthroughEdges(outpostIoNodes, allEdges);
  const effectiveEdges = [
    ...allEdges
      .filter((edge) => !passthroughNodeIds.has(edge.fromNode) && !passthroughNodeIds.has(edge.toNode))
      .map((edge) => ({
        id: edge.id,
        part: edge.part,
        fromNode: edge.fromNode,
        fromPort: edge.fromPort,
        toNode: edge.toNode,
        toPort: edge.toPort,
      })),
    ...splurgerPassthrough.edges,
    ...outpostIoPassthrough.edges,
  ];

  // Sink/Depot (Job's AWESOME Sink/Dimensional Depot addition) and Storage
  // Container rewrites — see this function's own header comment above and
  // `sinkPassthrough.ts`/`storagePassthrough.ts`'s headers. Each contributes
  // its own synthetic `syntheticCopyBasis` compound nodes, which join
  // `representableNodeIds` alongside real recipe nodes so the edge filters
  // below don't drop the very edges just rewritten to target them. Fed
  // `effectiveEdges` (already Splurger/outpost-io-composed), not the raw
  // edges — see this function's header.
  const sinkResult = computeSinkConsumerNodes(sinkNodes, effectiveEdges);
  const storageResult = computeStorageBufferNodes(storageNodes, effectiveEdges);
  const representableNodeIds = new Set([
    ...recipeNodeIds,
    ...sinkResult.nodes.map((n) => n.id),
    ...storageResult.nodes.map((n) => n.id),
  ]);
  const specialtyEdges = [...sinkResult.edges, ...storageResult.edges].filter(
    (edge) => representableNodeIds.has(edge.fromNode) && representableNodeIds.has(edge.toNode),
  );

  // A synthetic edge that still lands on a non-recipe, non-Sink/Storage
  // node (a chain spanning more than one pass-through hop — e.g. a Splurger
  // feeding directly into an outpost's Inputs node, or one outpost feeding
  // another — see `splurgerPassthrough.ts`'s header on why that's not
  // resolved here) is filtered out below, never passed through with a
  // dangling reference. This also naturally covers the plain, non-rewritten
  // recipe-to-recipe case (both `recipeNodeIds`), unchanged from before.
  const directEdges = effectiveEdges
    .filter((edge) => recipeNodeIds.has(edge.fromNode) && recipeNodeIds.has(edge.toNode))
    .map((edge) => ({
      id: edge.id,
      part: edge.part,
      fromNode: edge.fromNode,
      fromPort: edge.fromPort,
      toNode: edge.toNode,
      toPort: edge.toPort,
      ...("priorityTier" in edge && edge.priorityTier ? { priorityTier: edge.priorityTier } : {}),
    }));

  const nodes: SolverNode[] = [...recipeSolverNodes, ...sinkResult.nodes, ...storageResult.nodes];
  const edges: SolverEdge[] = [...directEdges, ...specialtyEdges];

  return { nodes, edges };
}
