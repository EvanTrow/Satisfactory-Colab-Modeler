// AWESOME Sink / Dimensional Depot Uploader (`kind: "sink"` / `"depot"`) —
// same "erase the unrepresentable node, rewrite its incident edges, let the
// existing solver machinery do the rest" pattern `splurgerPassthrough.ts`
// established for the Splurger node type, reused here via Job 026's
// `SolverNode.blueprintCopyBasis` escape hatch instead of a real
// `@scm/gamedata` recipe/machine lookup.
//
// Both node kinds are pure terminal consumers: one wildcard input handle
// (`in:*`, same `WILDCARD_PART` convention `SplurgerNode.tsx` uses — no
// changes needed to `edges/connectionLogic.ts`), accepting any number of
// distinct parts simultaneously, each independently capped by the node's own
// single `limit`/`limitMode` field (ppm by default per PLAN.md §2 — "Miners
// and AWESOME Sinks default to parts-per-minute"; `limit: null` means
// unlimited, matching a real AWESOME Sink with no belt-tier cap chosen).
//
// A sink accepting several DIFFERENT items at once cannot be one
// `SolverNode` the way a real recipe can — a recipe's parts move in lockstep
// off one shared machine-count knob, but a sink's connected items are
// independent flows with no fixed ratio between them. So this synthesizes
// ONE tiny single-part "consumer" compound node PER DISTINCT PART the sink
// touches (a `blueprintCopyBasis` recipe with exactly one negative part, á
// la a trivial Generator), each getting its own machine-count degree of
// freedom and the sink's own limit applied independently. Multiple upstream
// producers feeding the SAME part into one sink land on the SAME synthetic
// node — exactly the ordinary "several producers, one consumer, same part"
// shape `basic.ts`/`full.ts` already water-fill correctly.
//
// The rewritten edges get a MINTED id (`SINK_EDGE_ID_PREFIX` + the original
// edge id) rather than reusing the original — `sinkConsumerNodeId` groups
// every producer of the same part into one shared synthetic node, so the
// original id can't just be reused verbatim without inviting confusion about
// which of possibly-several original edges a given `SolverEdge` came from.
// Unlike Splurger's rewrite (which can MERGE two original edges into one
// synthetic edge with no single "original id" to point back to — see
// `splurgerPassthrough.ts`'s header), this rewrite is always exactly
// one-original-edge-in, one-synthetic-edge-out, so `originalEdgeIdFromSinkEdgeId`
// below can always recover it. `useSolver.ts`'s `indexEdges` uses that to
// additionally key its `edgeResultById` map by the ORIGINAL edge id, so
// `ConnectionEdge.tsx`'s label (keyed by the real, un-rewritten edge id) shows
// the solved rate for a sink connection exactly like any other connection.
// The sink's own card still separately reads the synthetic consumer node's
// `NodeSolveResult.partRates` via `sinkConsumerNodeId` (see
// `canvas/nodes/SinkNode.tsx`) for its aggregate-per-part display.
import type { LimitMode, SolverEdge, SolverNode } from "@scm/solver";

/** Prefix `computeSinkConsumerNodes` mints a rewritten edge's id with, ahead of the original edge's own id — see this module's header. */
export const SINK_EDGE_ID_PREFIX = "sk-e:";

/** Recovers the original (pre-rewrite) edge id from a sink-rewritten `SolverEdge.id`/`EdgeSolveResult.edgeId`, or `undefined` if `id` wasn't minted by this module. */
export function originalEdgeIdFromSinkEdgeId(id: string): string | undefined {
  return id.startsWith(SINK_EDGE_ID_PREFIX) ? id.slice(SINK_EDGE_ID_PREFIX.length) : undefined;
}

export interface SinkEdgeLike {
  readonly id: string;
  readonly part: string;
  readonly fromNode: string;
  readonly fromPort: string;
  readonly toNode: string;
  readonly toPort: string;
}

export interface SinkNodeLike {
  readonly id: string;
  readonly limit: string | null;
  readonly limitMode: LimitMode;
}

export interface SinkPassthroughResult {
  readonly nodes: readonly SolverNode[];
  readonly edges: readonly SolverEdge[];
}

/** Deterministic id for the synthetic single-part consumer standing in for `sinkNodeId`'s share of `part` — exported so `canvas/nodes/SinkNode.tsx` can look up its solved rate by the same id this module assigns. */
export function sinkConsumerNodeId(sinkNodeId: string, part: string): string {
  return `sk:${sinkNodeId}:${part}`;
}

/**
 * Rewrites every `sinks` node's incident (always incoming — a sink has no
 * output side) edges into edges targeting one synthetic per-part consumer
 * node each, grouped by part. A sink with no incident edges at all
 * contributes nothing (nothing to consume yet).
 */
export function computeSinkConsumerNodes(
  sinks: readonly SinkNodeLike[],
  edges: readonly SinkEdgeLike[],
): SinkPassthroughResult {
  const nodes: SolverNode[] = [];
  const rewrittenEdges: SolverEdge[] = [];

  for (const sink of sinks) {
    const incoming = edges.filter((e) => e.toNode === sink.id);
    if (incoming.length === 0) continue;

    const partsSeen = new Set<string>();
    for (const edge of incoming) {
      if (!partsSeen.has(edge.part)) {
        partsSeen.add(edge.part);
        nodes.push({
          id: sinkConsumerNodeId(sink.id, edge.part),
          recipe: "",
          machine: "",
          purity: null,
          limit: sink.limit,
          limitMode: sink.limitMode,
          clock: null,
          shards: 0,
          blueprintCopyBasis: { perCopyRates: { [edge.part]: "-1" }, perCopyPowerMW: 0 },
        });
      }
      rewrittenEdges.push({
        id: `${SINK_EDGE_ID_PREFIX}${edge.id}`,
        part: edge.part,
        fromNode: edge.fromNode,
        fromPort: edge.fromPort,
        toNode: sinkConsumerNodeId(sink.id, edge.part),
        toPort: `in:${edge.part}`,
      });
    }
  }

  return { nodes, edges: rewrittenEdges };
}
