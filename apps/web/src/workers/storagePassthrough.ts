// Storage Container (`kind: "storage"`) — same synthetic-`blueprintCopyBasis`
// rewrite `sinkPassthrough.ts` uses for AWESOME Sink/Dimensional Depot, but
// shaped differently: a Storage Container's whole point (per PLAN.md §2's
// "four modes: Partially Full / Full / Empty / Input = Output") is that its
// input and output sides are DECOUPLED — unlike a Splurger, in doesn't have
// to equal out. So instead of one passthrough edge per part connecting a
// real producer straight to a real consumer, each side gets its OWN
// independent synthetic compound node per distinct part:
//   - an incoming part-group becomes a synthetic CONSUMER (`perCopyRates:
//     { [part]: "-1" }`) with `limit: null` — a Storage Container always
//     accepts everything routed into it, no cap (the "unlimited input" the
//     job's request describes).
//   - an outgoing part-group becomes a synthetic PRODUCER (`perCopyRates:
//     { [part]: "1" }`) with `limit: null` — supplies exactly as much as
//     whatever's downstream demands, uncapped, the mirror image of an
//     unpinned real recipe node deriving its own rate from demand.
// Only the default `"partiallyFull"` `storageMode` gets this treatment —
// see `canvas/nodes/StorageNode.tsx`'s header for why the other three modes
// (which would each need genuinely different solver semantics: "Full"/
// "Empty" behave like an always-available/never-accepting source or sink,
// "Input = Output" is actual conservation like a Splurger) are accepted,
// flagged known gaps rather than implemented here.
//
// A Storage Container is allowed to carry more than one distinct part at
// once (per this job's own scope decision — "allow it, flag visually"
// rather than blocking the connection) — `multiPartNodeIds` reports which
// storage nodes are in that state so `StorageNode.tsx` can show a warning
// banner, mirroring `splurgerPassthrough.ts`'s `unsupportedNodeIds`.
//
// Same accepted "no per-edge `EdgeSolveResult`" limitation as
// `sinkPassthrough.ts` — see that module's header.
import type { SolverEdge, SolverNode } from "@scm/solver";

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
      });
    }
    rewrittenEdges.push(
      direction === "in"
        ? { id: `stg-e:${edge.id}`, part: edge.part, fromNode: edge.fromNode, fromPort: edge.fromPort, toNode: syntheticId, toPort: `in:${edge.part}` }
        : { id: `stg-e:${edge.id}`, part: edge.part, fromNode: syntheticId, fromPort: `out:${edge.part}`, toNode: edge.toNode, toPort: edge.toPort },
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

    synthesizeSide(storage.id, incoming, "in", nodes, rewrittenEdges);
    synthesizeSide(storage.id, outgoing, "out", nodes, rewrittenEdges);
  }

  return { nodes, edges: rewrittenEdges, multiPartNodeIds };
}
