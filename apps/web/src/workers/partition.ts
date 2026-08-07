// Turns a whole-document `SolverSnapshot` into per-connected-component
// sub-snapshots, each tagged with a content-addressed cache key
// (`signature`) — the "dirty-subgraph solving" half of PLAN.md §5 point 2.
// `solveScheduler.ts` uses `signature` to decide, per component, whether a
// cached result from a prior solve can be reused as-is or whether this
// component actually needs to go back through the worker.
import type { SolverEdge, SolverNode, SolverSnapshot } from "@scm/solver";

import { computeConnectedComponents } from "./connectedComponents";
import { idCompare } from "./ordering";

export interface SolverComponent {
  /** Just this component's own nodes/edges — what actually gets sent to the worker on a cache miss, and what a solved result gets sliced back into (see `mergeResults.ts`'s `splitResultByComponents`). */
  readonly snapshot: SolverSnapshot;
  /**
   * A content hash (well, content — see below) of this component's nodes
   * and edges, independent of the snapshot's own array order. Two calls
   * that partition the SAME logical graph state produce byte-identical
   * signatures for a given component even if node/edge creation order
   * differed; any change to a solver-relevant field on any node in the
   * component (limit, clock, shards, recipe, machine, purity) or to which
   * edges connect it changes the signature. Cache invalidation rules this
   * gives `solveScheduler.ts` for free:
   *   - Editing one node's limit changes only that node's own component's
   *     signature — every other component's signature (and thus cached
   *     result) is untouched.
   *   - Adding/removing an edge that crosses what were two components
   *     merges/splits them (`computeConnectedComponents`), which means
   *     BOTH of the old components' signatures cease to appear in the new
   *     partition at all (their cache entries simply go unused, not
   *     "invalidated" in place) and a new, different signature appears for
   *     the merged/split component(s) — which will always miss the cache
   *     the first time, forcing a real resolve.
   * Does NOT include `SolverMode` — a component's own content is
   * mode-independent; callers (`solveScheduler.ts`) combine this with the
   * current mode themselves, since the same content solved under "manual"
   * vs "basic" needs two different cache entries.
   */
  readonly signature: string;
}

function componentSignature(nodes: readonly SolverNode[], edges: readonly SolverEdge[]): string {
  const sortedNodes = [...nodes].sort((a, b) => idCompare(a.id, b.id));
  const sortedEdges = [...edges].sort((a, b) => idCompare(a.id, b.id));
  // Plain `JSON.stringify` of the full node/edge content (not just ids) —
  // components in this app are small (PLAN.md §2: "tens to low hundreds per
  // outpost"), so a real hash function would be premature; the string
  // itself is a perfectly good, trivially-correct Map key.
  return JSON.stringify({ nodes: sortedNodes, edges: sortedEdges });
}

export function partitionSnapshot(full: SolverSnapshot): SolverComponent[] {
  const nodeIds = full.nodes.map((n) => n.id);
  const graphComponents = computeConnectedComponents(nodeIds, full.edges);

  const nodeById = new Map(full.nodes.map((n) => [n.id, n] as const));
  const edgeById = new Map(full.edges.map((e) => [e.id, e] as const));

  return graphComponents.map((component) => {
    const nodes = component.nodeIds.map((id) => nodeById.get(id)!);
    const edges = component.edgeIds.map((id) => edgeById.get(id)!);
    return { snapshot: { nodes, edges }, signature: componentSignature(nodes, edges) };
  });
}
