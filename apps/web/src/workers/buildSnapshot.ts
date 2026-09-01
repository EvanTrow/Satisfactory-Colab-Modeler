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

import { outpostIoPassthroughNode } from "../canvas/outposts/io";
import { computePassthroughEdges, type PassthroughNode } from "./passthroughRouting";
import { mergerPassthroughNode, splitterPassthroughNode } from "./splitMergePassthrough";
import { computeSinkConsumerNodes } from "./sinkPassthrough";
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
 * `kind: "splitter"`/`"merger"` (the Conveyor/Smart/Programmable Splitter
 * and Conveyor/Priority Merger buildables, no recipe/machine of their own)
 * are the deliberate EXCEPTION to "silently excluded": neither ever becomes
 * a `SolverNode` itself, but their incident edges are first rewritten by
 * `passthroughRouting.ts`'s `computePassthroughEdges` (via each node's own
 * `splitMergePassthrough.ts` routing) into direct recipe-to-recipe
 * `SolverEdge`s carrying the node's own configured priority rank — so a real
 * Splitter/Merger sitting between two real recipe nodes participates in the
 * solve as if it weren't there, with zero changes to `@scm/solver` itself.
 * See `passthroughRouting.ts`'s header comment for exactly which wiring
 * shapes this can and can't represent.
 *
 * `kind: "sink"`/`"depot"` (AWESOME Sink/Dimensional Depot Uploader) and
 * `kind: "storage"` (Storage Container) get the same "rewrite before the
 * filter runs" treatment, via `sinkPassthrough.ts`/`storagePassthrough.ts`
 * — except neither erases itself into a direct edge between two REAL
 * nodes; each synthesizes its own tiny single-part `syntheticCopyBasis`
 * compound node(s) (an escape hatch for a node with no real gamedata
 * recipe) to stand in for what it consumes/produces, since none of these
 * three kinds has a fixed recipe ratio the way a Splitter/Merger's
 * passthrough rewrite can lean on. See those two modules' headers for why.
 *
 * Outpost I/O rework: the Splitter/Merger/outpost-input/outpost-output
 * rewrite runs FIRST, against the raw edges, and its OUTPUT (not the raw
 * edges) is what Sink/Storage/Depot's own rewrite sees. This ordering
 * matters for a chain like "producer -> outpost Outputs node -> AWESOME
 * Sink": the outpost rewrite alone turns this into "producer -> Sink", but
 * a Sink isn't a `recipe` node, so that synthetic edge would still be
 * dropped by the plain recipe-to-recipe filter; running Sink's OWN rewrite
 * on this ALREADY-composed edge (instead of the original "Outputs node ->
 * Sink" one, whose `fromNode` isn't a recipe node either) is what lets it
 * correctly see `producer` as the real source and mint its usual synthetic
 * consumer node from it. Without this ordering, a Splitter/Merger/outpost
 * pass-through node feeding directly into a Sink/Storage/Depot silently
 * vanished from the solve entirely (both sides' independent rewrites
 * individually correct, but composing to nothing) — confirmed live as "only
 * 1ppm flows unless a limit is set."
 *
 * That ordering alone only composes ONE pass-through hop, though — a chain
 * of two or more (an outpost's own Inputs -> Outputs pass-through, one
 * outpost feeding another, a Splitter feeding an outpost's Inputs node, ...)
 * still landed a synthetic edge on the OTHER still-erased node's id, which
 * this filter then dropped the same way, reproducing the exact same "flat
 * 1ppm" symptom one hop further out. `passthroughRouting.ts`'s
 * `computePassthroughEdges` folds its whole node list sequentially against
 * one shared pool instead of each node reading the same static input
 * independently (see that function's own header) — which is also why every
 * Splitter, Merger, and outpost I/O node is passed to ONE combined call
 * below (`passthroughNodes`), not several separate ones: a chain mixing
 * multiple kinds needs every node in it visible to the same fold.
 */
export function buildSolverSnapshot(sfmDoc: SfmDocument): SolverSnapshot {
  const allNodes = listNodes(sfmDoc);
  const recipeNodes = allNodes.filter((node) => node.kind === "recipe");
  const recipeNodeIds = new Set(recipeNodes.map((node) => node.id));
  const splitterNodes = allNodes.filter((node) => node.kind === "splitter");
  const mergerNodes = allNodes.filter((node) => node.kind === "merger");
  const sinkNodes = allNodes.filter((node) => node.kind === "sink" || node.kind === "depot");
  const storageNodes = allNodes.filter((node) => node.kind === "storage");
  // Outpost I/O rework: the two locked pass-through nodes every outpost
  // container gets (`canvas/outposts/io.ts`) are erased into direct
  // recipe-to-recipe edges the same generic way a Splitter/Merger is — see
  // `passthroughRouting.ts`'s header for the full design.
  const outpostIoNodes = allNodes.filter((node) => node.kind === "outpost-input" || node.kind === "outpost-output");
  // Splitters, Mergers, and outpost I/O nodes are folded away in ONE
  // combined call (below), not several separate ones —
  // `computePassthroughEdges` composes chains of pass-through nodes
  // sequentially against a shared pool (see its own header), which only
  // works across the FULL set of erasable nodes at once: a chain mixing
  // several kinds (e.g. a Splitter feeding directly into an outpost's Inputs
  // node) needs every node in the chain visible to the same fold, not split
  // across independent calls that can't see each other's synthetic edges.
  const passthroughNodes: PassthroughNode[] = [
    ...splitterNodes.map(splitterPassthroughNode),
    ...mergerNodes.map(mergerPassthroughNode),
    ...outpostIoNodes.map((node) => outpostIoPassthroughNode(node.id)),
  ];

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

  // Splitter/Merger/outpost-input/outpost-output pass-through rewrite — run
  // FIRST, see this function's own header comment for why. Every edge
  // incident to one of these nodes is erased from the pool entirely (whether
  // it produced a synthetic replacement or was dangling/unsupported — see
  // `passthroughRouting.ts`'s header) and, where a replacement exists, that
  // takes its place instead.
  const passthroughNodeIds = new Set(passthroughNodes.map((node) => node.id));
  const passthrough = computePassthroughEdges(passthroughNodes, allEdges);
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
    ...passthrough.edges,
  ];

  // Sink/Depot (AWESOME Sink/Dimensional Depot addition) and Storage
  // Container rewrites — see this function's own header comment above and
  // `sinkPassthrough.ts`/`storagePassthrough.ts`'s headers. Each contributes
  // its own synthetic `syntheticCopyBasis` compound nodes, which join
  // `representableNodeIds` alongside real recipe nodes so the edge filters
  // below don't drop the very edges just rewritten to target them. Fed
  // `effectiveEdges` (already Splitter/Merger/outpost-io-composed), not the
  // raw edges — see this function's header.
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
  // node — now only a genuinely unsupported shape (a multi-in-AND-multi-out
  // part-group somewhere in the chain, `passthroughRouting.ts`'s own
  // `unsupportedNodeIds`) or a dangling one (nothing wired on the far side
  // at all), since an ordinary multi-hop chain is already composed all the
  // way through by `computePassthroughEdges` above — is filtered out below,
  // never passed through with a dangling reference. This also naturally
  // covers the plain, non-rewritten recipe-to-recipe case (both
  // `recipeNodeIds`), unchanged from before.
  const directEdges = effectiveEdges
    .filter((edge) => recipeNodeIds.has(edge.fromNode) && recipeNodeIds.has(edge.toNode))
    .map((edge) => ({
      id: edge.id,
      part: edge.part,
      fromNode: edge.fromNode,
      fromPort: edge.fromPort,
      toNode: edge.toNode,
      toPort: edge.toPort,
      // `priorityTier` is a rank (0 = highest priority) — `0` is a genuine,
      // meaningful value here, not "unset", so this must check `!==
      // undefined` rather than truthiness (a plain `edge.priorityTier &&
      // ...` would wrongly drop an explicit rank-0 tag).
      ...("priorityTier" in edge && edge.priorityTier !== undefined ? { priorityTier: edge.priorityTier } : {}),
    }));

  const nodes: SolverNode[] = [...recipeSolverNodes, ...sinkResult.nodes, ...storageResult.nodes];
  const edges: SolverEdge[] = [...directEdges, ...specialtyEdges];

  return { nodes, edges };
}
