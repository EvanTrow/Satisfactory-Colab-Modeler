// Storage Container (`kind: "storage"`) — same synthetic-`blueprintCopyBasis`
// rewrite `sinkPassthrough.ts` uses for AWESOME Sink/Dimensional Depot, but
// shaped differently: a Storage Container's whole point is that its input
// and output sides are DECOUPLED — unlike a Splurger, in doesn't have to
// equal out. So instead of one passthrough edge per part connecting a real
// producer straight to a real consumer, each side gets its OWN independent
// synthetic compound node per distinct part:
//   - an incoming part-group becomes a synthetic CONSUMER (`perCopyRates:
//     { [part]: "-1" }`) with `limit: null` — a Storage Container always
//     accepts everything routed into it, no cap (the "unlimited input" the
//     job's request describes).
//   - an outgoing part-group becomes a synthetic PRODUCER (`perCopyRates:
//     { [part]: "1" }`) with `limit: null` — supplies exactly as much as
//     whatever's downstream demands, uncapped, the mirror image of an
//     unpinned real recipe node deriving its own rate from demand.
//
// The consumer and producer nodes for the SAME part have no solver edge
// between them at all (that's the decoupling) — which means, on its own, an
// upstream pin can propagate into the intake side but has no graph path to
// reach the outflow side, AND the outflow side has no way to know it can
// never emit more than the intake side actually received. Left alone, the
// first half of that made a Storage Container's output default to
// Basic/Full mode's plain `ONE`-machine fallback (an almost-always-wrong
// flat rate) unless the user happened to also pin something downstream; the
// second half meant that once something downstream WAS pinned, the output
// would happily report whatever downstream demanded even if it exceeded
// what the intake side was actually supplying (physically impossible for a
// real buffer — you can't emit more than you take in). Both fixed via
// `@scm/solver`'s `SolverNode.capMachineCountAtNodeId` (see that field's own
// doc comment in `snapshot.ts`): the producer node for a part that also has
// an intake-side consumer node points `capMachineCountAtNodeId` at that
// consumer's id, so once the intake side resolves (from whatever's actually
// feeding it), Basic/Full mode's propagation loop both (a) lets the outflow
// side borrow that count when nothing downstream can supply one at all, and
// (b) CAPS the outflow side at it even when downstream demands more — with
// the shortfall then flagged on the downstream node via the ordinary rate-
// mismatch/insufficient-input machinery, same as any two ordinary mismatched
// pinned nodes.
//
// A Storage Container is allowed to carry more than one distinct part at
// once (per this job's own scope decision — "allow it, flag visually"
// rather than blocking the connection) — `multiPartNodeIds` reports which
// storage nodes are in that state so `StorageNode.tsx` can show a warning
// banner, mirroring `splurgerPassthrough.ts`'s `unsupportedNodeIds`.
//
// Calculation-validation visuals pass: unlike Splurger's rewrite (which can
// genuinely MERGE two original edges into one synthetic edge with no single
// recoverable "original id" — see that module's own header), THIS rewrite is
// always exactly one-original-edge-in, one-synthetic-edge-out, same shape as
// `sinkPassthrough.ts`'s. So it gets the exact same fix that module already
// has: `originalEdgeIdFromStorageEdgeId` below lets `useSolver.ts`'s
// `indexEdges` alias a storage-rewritten `EdgeSolveResult` back under the
// real edge id, so a connection feeding/leaving a Storage Container shows
// its solved rate AND validity coloring like any other connection — this
// was previously a real, accepted gap (this comment used to say so), just
// never actually fixed here the way Sink's own equivalent already was.
import type { SolverEdge, SolverNode } from "@scm/solver";

/** Prefix every rewritten storage edge id is minted with, ahead of the original edge's own id — mirrors `sinkPassthrough.ts`'s `SINK_EDGE_ID_PREFIX` exactly. */
export const STORAGE_EDGE_ID_PREFIX = "stg-e:";

/** Recovers the original (pre-rewrite) edge id from a storage-rewritten `SolverEdge.id`/`EdgeSolveResult.edgeId`, or `undefined` if `id` wasn't minted by this module — mirrors `sinkPassthrough.ts`'s `originalEdgeIdFromSinkEdgeId`. */
export function originalEdgeIdFromStorageEdgeId(id: string): string | undefined {
  return id.startsWith(STORAGE_EDGE_ID_PREFIX) ? id.slice(STORAGE_EDGE_ID_PREFIX.length) : undefined;
}

export interface StorageEdgeLike {
  readonly id: string;
  readonly part: string;
  readonly fromNode: string;
  readonly fromPort: string;
  readonly toNode: string;
  readonly toPort: string;
}

export interface StorageNodeLike {
  readonly id: string;
}

export interface StorageBufferResult {
  readonly nodes: readonly SolverNode[];
  readonly edges: readonly SolverEdge[];
  /** Storage node ids whose incident edges touch more than one distinct part. */
  readonly multiPartNodeIds: ReadonlySet<string>;
}

/** Deterministic id for the synthetic consumer standing in for `storageNodeId`'s intake of `part`. */
export function storageConsumerNodeId(storageNodeId: string, part: string): string {
  return `stg-in:${storageNodeId}:${part}`;
}

/** Deterministic id for the synthetic producer standing in for `storageNodeId`'s supply of `part`. */
export function storageProducerNodeId(storageNodeId: string, part: string): string {
  return `stg-out:${storageNodeId}:${part}`;
}

function synthesizeSide(
  storageNodeId: string,
  edgesForSide: readonly StorageEdgeLike[],
  direction: "in" | "out",
  nodes: SolverNode[],
  rewrittenEdges: SolverEdge[],
  // Only ever passed for the "out" side — see `computeStorageBufferNodes`.
  // The set of parts the "in" side ALSO has a synthetic consumer node for,
  // so the producer can be capped at that consumer's resolved machine count
  // (`@scm/solver`'s `SolverNode.capMachineCountAtNodeId`) once it resolves
  // — both as a fallback whenever nothing downstream happens to be pinned,
  // AND as a hard ceiling even when downstream demands more than the intake
  // side actually received.
  cappablePartsFromIntake?: ReadonlySet<string>,
): void {
  const idFor = direction === "in" ? storageConsumerNodeId : storageProducerNodeId;
  const sign = direction === "in" ? "-1" : "1";
  const seenParts = new Set<string>();

  for (const edge of edgesForSide) {
    const syntheticId = idFor(storageNodeId, edge.part);
    if (!seenParts.has(edge.part)) {
      seenParts.add(edge.part);
      nodes.push({
        id: syntheticId,
        recipe: "",
        machine: "",
        purity: null,
        limit: null,
        limitMode: "ppm",
        clock: null,
        shards: 0,
        blueprintCopyBasis: { perCopyRates: { [edge.part]: sign }, perCopyPowerMW: 0 },
        ...(cappablePartsFromIntake?.has(edge.part)
          ? { capMachineCountAtNodeId: storageConsumerNodeId(storageNodeId, edge.part) }
          : {}),
      });
    }
    rewrittenEdges.push(
      direction === "in"
        ? { id: `${STORAGE_EDGE_ID_PREFIX}${edge.id}`, part: edge.part, fromNode: edge.fromNode, fromPort: edge.fromPort, toNode: syntheticId, toPort: `in:${edge.part}` }
        : { id: `${STORAGE_EDGE_ID_PREFIX}${edge.id}`, part: edge.part, fromNode: syntheticId, fromPort: `out:${edge.part}`, toNode: edge.toNode, toPort: edge.toPort },
    );
  }
}

/**
 * Rewrites every `storages` node's incident edges into edges targeting one
 * synthetic per-part consumer (incoming side) or producer (outgoing side)
 * node each. A storage node with no incident edges at all contributes
 * nothing.
 */
export function computeStorageBufferNodes(
  storages: readonly StorageNodeLike[],
  edges: readonly StorageEdgeLike[],
): StorageBufferResult {
  const nodes: SolverNode[] = [];
  const rewrittenEdges: SolverEdge[] = [];
  const multiPartNodeIds = new Set<string>();

  for (const storage of storages) {
    const incoming = edges.filter((e) => e.toNode === storage.id);
    const outgoing = edges.filter((e) => e.fromNode === storage.id);
    if (incoming.length === 0 && outgoing.length === 0) continue;

    const distinctParts = new Set([...incoming, ...outgoing].map((e) => e.part));
    if (distinctParts.size > 1) multiPartNodeIds.add(storage.id);

    const intakeParts = new Set(incoming.map((e) => e.part));
    synthesizeSide(storage.id, incoming, "in", nodes, rewrittenEdges);
    synthesizeSide(storage.id, outgoing, "out", nodes, rewrittenEdges, intakeParts);
  }

  return { nodes, edges: rewrittenEdges, multiPartNodeIds };
}
