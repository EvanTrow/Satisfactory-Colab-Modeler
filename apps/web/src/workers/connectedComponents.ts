// The dirty-subgraph partitioning primitive PLAN.md §5 point 2 calls for:
// "partition the graph into connected components ... re-solve only
// components touched by an edit." This operates on the REAL underlying
// node/edge graph (a plain `{id, fromNode, toNode}` shape matching
// `@scm/solver`'s `SolverEdge`) — never on `apps/web/src/canvas/outposts/
// visibleGraph.ts`'s derived/projected boundary edges. An outpost container
// is a UI rendering concept (Job 013): its boundary node and the ports
// computed for it are recomputed fresh every render and never change what
// a real `EdgeRecord` actually connects. PLAN.md's "outposts already
// partition the graph naturally" is a description of a *typical* usage
// pattern (most connections stay internal to one outpost), not a
// structural guarantee — nothing here assumes it. See `jobs/013-outposts.md`
// Handoff notes, "The boundary-crossing-edge design decision", for the full
// argument.
//
// Deliberately a plain, generic graph algorithm — no `@scm/ydoc` or
// `@scm/solver` import, no knowledge of what a node/edge otherwise means —
// so it's testable with tiny synthetic fixtures and reusable if any other
// dirty-subgraph question ever comes up.
import { idCompare } from "./ordering";

export interface ComponentEdgeLike {
  readonly id: string;
  readonly fromNode: string;
  readonly toNode: string;
}

export interface GraphComponent {
  /** Sorted via `idCompare`. Every id in `nodeIds` passed to `computeConnectedComponents` appears in exactly one component's `nodeIds` — including a node with no edges at all (a singleton component). */
  readonly nodeIds: readonly string[];
  /** Sorted via `idCompare`. Every edge whose `fromNode`/`toNode` are both in this component (which, for a connected component, is every edge incident to any of its nodes). */
  readonly edgeIds: readonly string[];
}

/**
 * Partitions `nodeIds` into connected components using `edges` — union-find
 * with path compression and union-by-size, so this is fast (effectively
 * linear) even at the 500-node/800-edge budget PLAN.md §9 names. An edge
 * whose `fromNode`/`toNode` isn't in `nodeIds` is ignored (defensive — a
 * `SolverSnapshot` already filtered to recipe-kind nodes only, per
 * `buildSnapshot.ts`, should never produce one, but a dangling reference
 * shouldn't crash partitioning either way).
 *
 * Deterministic regardless of `nodeIds`/`edges` array order: union-by-size
 * ties are broken by `idCompare` on the two candidate roots, and every
 * returned list (`nodeIds`, `edgeIds`, and the component list itself, keyed
 * by its smallest node id) is sorted before returning.
 */
export function computeConnectedComponents(
  nodeIds: readonly string[],
  edges: readonly ComponentEdgeLike[],
): GraphComponent[] {
  const parent = new Map<string, string>();
  const size = new Map<string, number>();
  for (const id of nodeIds) {
    parent.set(id, id);
    size.set(id, 1);
  }

  function find(id: string): string {
    let root = id;
    // Terminates: `parent` forms a finite forest with no cycles.
    while (true) {
      const next = parent.get(root)!;
      if (next === root) break;
      root = next;
    }
    // Path compression: repoint every visited node straight at the root.
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const sizeA = size.get(rootA)!;
    const sizeB = size.get(rootB)!;
    // Union by size; ties broken by `idCompare` so the winning root — and
    // therefore every bit of bookkeeping keyed off it — never depends on
    // which order edges were processed in.
    if (sizeA < sizeB || (sizeA === sizeB && idCompare(rootA, rootB) > 0)) {
      parent.set(rootA, rootB);
      size.set(rootB, sizeA + sizeB);
    } else {
      parent.set(rootB, rootA);
      size.set(rootA, sizeA + sizeB);
    }
  }

  const validEdges: ComponentEdgeLike[] = [];
  for (const edge of edges) {
    if (!parent.has(edge.fromNode) || !parent.has(edge.toNode)) continue;
    validEdges.push(edge);
    union(edge.fromNode, edge.toNode);
  }

  const nodesByRoot = new Map<string, string[]>();
  for (const id of nodeIds) {
    const root = find(id);
    const list = nodesByRoot.get(root);
    if (list) list.push(id);
    else nodesByRoot.set(root, [id]);
  }

  const edgeIdsByRoot = new Map<string, string[]>();
  for (const edge of validEdges) {
    const root = find(edge.fromNode);
    const list = edgeIdsByRoot.get(root);
    if (list) list.push(edge.id);
    else edgeIdsByRoot.set(root, [edge.id]);
  }

  const components: GraphComponent[] = [];
  for (const [root, ids] of nodesByRoot) {
    components.push({
      nodeIds: sortedIdsOf(ids),
      edgeIds: sortedIdsOf(edgeIdsByRoot.get(root) ?? []),
    });
  }
  components.sort((a, b) => idCompare(a.nodeIds[0]!, b.nodeIds[0]!));
  return components;
}

function sortedIdsOf(ids: readonly string[]): string[] {
  return [...ids].sort(idCompare);
}
