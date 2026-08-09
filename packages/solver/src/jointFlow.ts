// Generalizes `waterFill.ts`'s single-group max-min-fair allocation to a
// full bipartite graph — multiple independent SOURCE nodes feeding multiple
// independent TARGET nodes for the same part, all at once. See `full.ts`'s
// own header ("A DOCUMENTED SCOPE LIMITATION") for why this is needed: the
// existing per-group approach (`edgeGroups.ts`'s `edgeShareFromSource`/
// `edgeShareFromTarget`, and `full.ts`'s `computeGroupAllocations`) caps
// each edge at the OTHER endpoint's full total, with no awareness of what
// OTHER sources/targets are simultaneously contributing to/draining that
// same endpoint. That is exact for a single splitter or single merger in
// isolation, but wrong the instant two splitter/merger points sit directly
// adjacent on the same part — e.g. the byproduct-reuse case
// (`applyByproductReuse` in the web app's generator): a byproduct source
// and its raw producer both wired into the SAME set of downstream
// consumers. Each side's independent even-split can double-cap a
// low-demand consumer (starving a high-demand sibling of the overflow it
// should have received) even though the two sides' TOTALS balance exactly.
//
// ---------------------------------------------------------------------------
// THE ALGORITHM — bipartite progressive water-filling, closed-form
// ---------------------------------------------------------------------------
//
// This is the direct bipartite generalization of `waterFill.ts`'s own
// closed-form max-min-fair solution (see that module's header for the
// single-group LP this generalizes). Every vertex (a source OR a target —
// disjoint id namespaces, see `jointMaxMinFairFlow`'s own doc comment) has a
// fixed total to send/receive; every edge connects exactly one source
// vertex to one target vertex.
//
// Each round: every vertex with at least one still-active incident edge has
// a "bound" — its remaining total divided evenly across its remaining
// active edges, i.e. what it would give/take per edge if nothing else
// constrained it. The GLOBAL MINIMUM bound, across every vertex on EITHER
// side, identifies the tightest constraint in the whole graph — permanently
// fix every edge incident to a vertex (or vertices, if tied) achieving that
// minimum at exactly that value, deduct it from both endpoints, and remove
// those edges from consideration. Repeat over the shrunken remainder.
//
// This is correct because the fixed value can never exceed what the OTHER
// endpoint of any newly-finalized edge can itself supply/absorb: the global
// minimum is by definition <= every other active vertex's own bound,
// including the other endpoint's, so committing to it never over-draws that
// endpoint's own remaining budget across its own remaining edges.
//
// Terminates in at most `edges.length` rounds (same argument as
// `waterFillTier`): every round finalizes every edge incident to at least
// one globally-minimal vertex, which is always a non-empty set, so at least
// one edge is permanently removed each round.
//
// DETERMINISM: exact `Rational` arithmetic throughout — dividing a total by
// an integer active-edge count is exact, so there is no rounding to break
// ties over. Ties in the global minimum are resolved by finalizing EVERY
// tied vertex's edges in the SAME round (Jacobi-style, matching
// `basic.ts`/`waterFill.ts`'s own discipline) rather than picking one
// arbitrarily, so the result cannot depend on iteration order. Vertex/edge
// ids are still sorted before iterating, purely so intermediate bookkeeping
// is reproducible too (the final `rate`/`shortfall` maps do not depend on
// it either way, since every edge/vertex is visited exactly once as it's
// finalized).
//
// A GENUINE supply/demand IMBALANCE in a connected component (the graph's
// total source capacity doesn't match its total target demand) is not an
// error this algorithm rejects — it degrades gracefully: whichever side
// runs out first ends the round with `remaining > 0` on the OTHER side,
// reported via `shortfall`. The caller (`edgeResolution.ts`) decides what
// that means for edge validity.
//
// PRIORITY TIERS ("top"/"bottom", Full mode only — see `snapshot.ts`'s
// `PriorityTier`) are NOT modeled here. `edgeResolution.ts` falls back to
// the existing per-group `computeGroupAllocations` path (unchanged) for any
// connected component containing a tiered edge — a documented, narrower
// scope than full generality, matching this fix's actual target (the
// untiered byproduct-reuse topology) rather than attempting a joint
// two-tier bipartite solve nobody has asked for yet.
import { ZERO, compare, divide, equals, isPositive, of, subtract, type Rational } from "@scm/rational";
import { idCompare } from "./ordering";
import { SolveCancelledError, type CancellationSignal } from "./waterFill";

export interface JointFlowEdge {
  readonly id: string;
  /** Source-side vertex key. */
  readonly from: string;
  /** Target-side vertex key. */
  readonly to: string;
}

export interface JointFlowResult {
  /** `edgeId` -> its finalized share. Every edge passed in appears, even at `ZERO`. */
  readonly rate: ReadonlyMap<string, Rational>;
  /** Vertex key -> its unfilled remaining total. Only present (and always positive) for a vertex a genuine supply/demand imbalance left short — absent (not zero) for every vertex fully resolved. */
  readonly shortfall: ReadonlyMap<string, Rational>;
}

/**
 * Solves the bipartite max-min-fair allocation described in this module's
 * header. `totals` covers every vertex `edges` references, keyed by
 * whatever string the caller uses to identify it — the SAME key can't be
 * reused for both a source and a target role (a node that is simultaneously
 * a source for one edge and a target for another, e.g. a node whose recipe
 * lists a part twice, needs two DISTINCT keys, one per direction/port — see
 * `edgeResolution.ts`'s own `sourceKey`/`targetKey` helpers). A vertex
 * missing from `totals` is treated as `ZERO`.
 */
export function jointMaxMinFairFlow(
  totals: ReadonlyMap<string, Rational>,
  edges: readonly JointFlowEdge[],
  signal?: CancellationSignal,
): JointFlowResult {
  const rate = new Map<string, Rational>();
  const remaining = new Map<string, Rational>();
  const activeByVertex = new Map<string, Set<string>>();
  const edgeById = new Map<string, JointFlowEdge>();

  function touch(vertex: string): Set<string> {
    let set = activeByVertex.get(vertex);
    if (!set) {
      set = new Set();
      activeByVertex.set(vertex, set);
      remaining.set(vertex, totals.get(vertex) ?? ZERO);
    }
    return set;
  }

  for (const e of edges) {
    edgeById.set(e.id, e);
    rate.set(e.id, ZERO);
    touch(e.from).add(e.id);
    touch(e.to).add(e.id);
  }

  let activeCount = edges.length;
  while (activeCount > 0) {
    if (signal?.aborted) throw new SolveCancelledError();

    const activeVertexIds = [...activeByVertex.keys()]
      .filter((v) => activeByVertex.get(v)!.size > 0)
      .sort(idCompare);

    let minBound: Rational | null = null;
    const boundByVertex = new Map<string, Rational>();
    for (const v of activeVertexIds) {
      const bound = divide(remaining.get(v)!, of(activeByVertex.get(v)!.size));
      boundByVertex.set(v, bound);
      if (minBound === null || compare(bound, minBound) < 0) minBound = bound;
    }
    if (minBound === null) break; // no active vertices left — shouldn't happen while activeCount > 0, defensive

    const m = minBound;
    const criticalVertices = activeVertexIds.filter((v) => equals(boundByVertex.get(v)!, m));

    const toFinalize = new Set<string>();
    for (const v of criticalVertices) {
      for (const eid of activeByVertex.get(v)!) toFinalize.add(eid);
    }

    for (const eid of [...toFinalize].sort(idCompare)) {
      const e = edgeById.get(eid)!;
      rate.set(eid, m);
      activeCount -= 1;
      for (const v of [e.from, e.to]) {
        activeByVertex.get(v)!.delete(eid);
        remaining.set(v, subtract(remaining.get(v)!, m));
      }
    }
  }

  const shortfall = new Map<string, Rational>();
  for (const [v, r] of remaining) {
    if (isPositive(r)) shortfall.set(v, r);
  }

  return { rate, shortfall };
}

/**
 * Partitions `edges` into connected components over the bipartite
 * (from-vertex, to-vertex) graph — the unit `jointMaxMinFairFlow` should be
 * called once per component (edges in different components share no vertex
 * and so can never influence each other's allocation). Plain union-find;
 * deterministic regardless of `edges`' order (component membership is an
 * order-independent property of the graph, and this returns components
 * sorted by their smallest edge id purely for reproducible iteration by
 * callers).
 */
export function groupConnectedComponents<E extends JointFlowEdge>(edges: readonly E[]): E[][] {
  const parent = new Map<string, string>();
  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    if (!parent.has(x)) parent.set(x, x);
    parent.set(x, root);
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const e of edges) {
    find(e.from);
    find(e.to);
    union(e.from, e.to);
  }

  const byRoot = new Map<string, E[]>();
  for (const e of edges) {
    const root = find(e.from);
    const list = byRoot.get(root) ?? [];
    list.push(e);
    byRoot.set(root, list);
  }

  return [...byRoot.values()]
    .map((list) => list.sort((a, b) => idCompare(a.id, b.id)))
    .sort((a, b) => idCompare(a[0]!.id, b[0]!.id));
}
