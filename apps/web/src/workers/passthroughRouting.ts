// The generic, node-kind-agnostic engine behind every "erase this node,
// rewrite its incident edges into direct recipe-to-recipe SolverEdges"
// mechanism in this app — shared by the outpost Inputs/Outputs nodes
// (`canvas/outposts/io.ts`) and the Splitter/Merger buildables
// (`splitMergePassthrough.ts`). Neither `@scm/ydoc` nor React is imported
// here — plain data in, plain data out, same discipline
// `connectedComponents.ts`/`partition.ts` already established in this
// directory.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AS ITS OWN MODULE (read before touching anything below)
// ---------------------------------------------------------------------------
//
// `@scm/solver`'s `SolverSnapshot` can only represent `kind: "recipe"` nodes
// (see `buildSnapshot.ts`'s header) — there is no solver-side concept of a
// pure routing node. Every node kind that's "just wiring" (outpost I/O,
// Splitter, Merger) is instead erased by `buildSnapshot.ts` BEFORE the
// snapshot reaches `@scm/solver`: its incident edges are rewritten into
// direct producer-to-consumer `PassthroughSolverEdge`s, each carrying a
// priority RANK (`@scm/solver`'s `PriorityTier`, a plain number — rank 0
// drains first) so Full mode's existing per-(node,part,direction) sibling
// water-filling applies unchanged, anchored at the REAL recipe nodes on
// either end.
//
// This is exact (not an approximation) for the shapes real Satisfactory
// splitter/merger hardware actually has — one input across several outputs,
// or several inputs into one output — since those are precisely the shapes
// the solver's own sibling-group water-filling already solves correctly for
// a real recipe node's own ports. A node wired with multiple inputs AND
// multiple outputs on the same part simultaneously has no correct rewrite:
// naively connecting every input to every output (a "crossbar") would let
// two independent downstream water-fills both believe they can draw a
// source's full capacity, a genuine double-counting bug. Each node's own
// `resolveRanks` callback (below) reports this shape as `"unsupported"`
// rather than guessing at a wrong answer; the caller surfaces it as a
// visible warning instead of silently dropping flow.
//
// MULTI-HOP CHAINS: `computePassthroughEdges` folds `nodes` SEQUENTIALLY
// against one shared, mutable working pool (starting as `edges`) rather than
// each node independently reading the same static input — after a node is
// processed, every edge that touched it is replaced in the pool by whatever
// synthetic edge(s) its own fold produced. This is what lets a chain of two
// or more pass-through nodes in a row (a Splitter feeding an outpost's
// Inputs node, one outpost feeding another, ...) compose all the way through
// to a single real-producer -> real-consumer edge in one pass, instead of
// each node's rewrite independently landing on the OTHER erased node's
// still-unresolved id and getting silently dropped by `buildSnapshot.ts`'s
// "both endpoints must be representable" filter — this is real, previously
// broken behavior (confirmed live as a flat 1ppm fallback for exactly this
// shape), not a hypothetical concern. `nodes` must therefore include EVERY
// erasable node in one combined call for a chain mixing several kinds
// (outpost I/O + Splitter, etc.) to compose correctly — see
// `buildSnapshot.ts` for where that combined list is built.

export interface PassthroughEdgeLike {
  readonly id: string;
  readonly part: string;
  readonly fromNode: string;
  readonly fromPort: string;
  readonly toNode: string;
  readonly toPort: string;
}

/**
 * One node this engine can erase. `resolveRanks` is called once per
 * PART-GROUP incident on this node (i.e. once per distinct `part` among its
 * currently-pooled incident edges), and decides how that part-group routes:
 * a rank (lower drains/fills first) for every input and every output edge
 * in the group, or `"unsupported"` if the shape can't be routed at all
 * (reported back to the caller, never silently dropped).
 */
export interface PassthroughNode {
  readonly id: string;
  resolveRanks(
    part: string,
    inputs: readonly PassthroughEdgeLike[],
    outputs: readonly PassthroughEdgeLike[],
  ):
    | { readonly inputRanks: ReadonlyMap<string, number>; readonly outputRanks: ReadonlyMap<string, number> }
    | "unsupported";
}

export interface PassthroughSolverEdge {
  readonly id: string;
  readonly part: string;
  readonly fromNode: string;
  readonly fromPort: string;
  readonly toNode: string;
  readonly toPort: string;
  readonly priorityTier?: number;
  /**
   * The two original incident edge ids merged into this synthetic edge —
   * lets a passthrough node's own UI recover a real `EdgeSolveResult` for
   * one of its OWN edges (which never reaches the solver directly) by
   * looking up `edgeResultById.get(synthetic.id)` after finding which
   * synthetic edge a given original edge id was folded into. Purely
   * additive — no existing caller reads this field.
   */
  readonly sourceEdgeIds: { readonly input: string; readonly output: string };
}

export interface PassthroughResult {
  readonly edges: readonly PassthroughSolverEdge[];
  /**
   * Node ids with at least one part-group whose `resolveRanks` reported
   * `"unsupported"` — the caller (typically a node's own UI) uses this to
   * warn the user their wiring isn't being routed by the solver rather than
   * leaving them to notice a silent flow discrepancy on their own.
   */
  readonly unsupportedNodeIds: ReadonlySet<string>;
}

/** A pooled edge is either an original, untouched `PassthroughEdgeLike` or a `PassthroughSolverEdge` some earlier fold already produced. */
type PooledEdge = PassthroughEdgeLike | PassthroughSolverEdge;

function isSynthetic(e: PooledEdge): e is PassthroughSolverEdge {
  return "sourceEdgeIds" in e;
}

/** The TRUE original edge id nearest `e`'s input side — `e.id` itself for a raw edge, or the already-traced-back id a prior fold recorded for a synthetic one. */
function originalInputId(e: PooledEdge): string {
  return isSynthetic(e) ? e.sourceEdgeIds.input : e.id;
}

/** The TRUE original edge id nearest `e`'s output side — see `originalInputId`. */
function originalOutputId(e: PooledEdge): string {
  return isSynthetic(e) ? e.sourceEdgeIds.output : e.id;
}

/**
 * Maps each ORIGINAL edge id that folded into exactly ONE synthetic edge to
 * that synthetic edge's id — the passthrough-node analogue of
 * `sinkPassthrough.ts`/`storagePassthrough.ts`'s own `originalEdgeIdFrom*`
 * aliasing. A one-to-many part-group (a Splitter's single input edge feeding
 * several synthetic output edges, or a Merger's single output edge fed by
 * several synthetic input edges) genuinely has no single correct rate to
 * alias its "few" side to, so only the unambiguous ids are aliased — a
 * genuinely multi-way edge stays unaliased, same "unknown, not a guess"
 * posture `classifyEdgeValidity` already takes for a missing result.
 */
export function computePassthroughEdgeAliases(
  nodes: readonly PassthroughNode[],
  edges: readonly PassthroughEdgeLike[],
): ReadonlyMap<string, string> {
  const { edges: synthetic } = computePassthroughEdges(nodes, edges);
  const countByOriginal = new Map<string, number>();
  for (const s of synthetic) {
    countByOriginal.set(s.sourceEdgeIds.input, (countByOriginal.get(s.sourceEdgeIds.input) ?? 0) + 1);
    countByOriginal.set(s.sourceEdgeIds.output, (countByOriginal.get(s.sourceEdgeIds.output) ?? 0) + 1);
  }
  const aliases = new Map<string, string>();
  for (const s of synthetic) {
    if (countByOriginal.get(s.sourceEdgeIds.input) === 1) aliases.set(s.sourceEdgeIds.input, s.id);
    if (countByOriginal.get(s.sourceEdgeIds.output) === 1) aliases.set(s.sourceEdgeIds.output, s.id);
  }
  return aliases;
}

/**
 * Rewrites every node in `nodes`'s incident edges into direct
 * producer-to-consumer `PassthroughSolverEdge`s, grouped by `part` (a node
 * carrying two different parts across different port pairs is treated as
 * two entirely independent routing decisions) — see this module's header
 * for the multi-hop chain-composition discipline and the "unsupported"
 * crossbar shape this deliberately does not attempt to rewrite.
 */
export function computePassthroughEdges(
  nodes: readonly PassthroughNode[],
  edges: readonly PassthroughEdgeLike[],
): PassthroughResult {
  const unsupportedNodeIds = new Set<string>();
  let pool: readonly PooledEdge[] = edges;

  for (const node of nodes) {
    const incident = pool.filter((e) => e.fromNode === node.id || e.toNode === node.id);
    if (incident.length === 0) continue;

    const byPart = new Map<string, { inputs: PooledEdge[]; outputs: PooledEdge[] }>();
    for (const edge of incident) {
      const group = byPart.get(edge.part) ?? { inputs: [], outputs: [] };
      if (edge.toNode === node.id) group.inputs.push(edge);
      if (edge.fromNode === node.id) group.outputs.push(edge);
      byPart.set(edge.part, group);
    }

    const additions: PassthroughSolverEdge[] = [];
    for (const [part, group] of byPart) {
      const { inputs, outputs } = group;
      if (inputs.length === 0 || outputs.length === 0) continue;

      const ranks = node.resolveRanks(part, inputs, outputs);
      if (ranks === "unsupported") {
        unsupportedNodeIds.add(node.id);
        continue;
      }

      if (inputs.length === 1) {
        const input = inputs[0]!;
        for (const output of outputs) {
          additions.push({
            id: `sp:${input.id}>${output.id}`,
            part,
            fromNode: input.fromNode,
            fromPort: input.fromPort,
            toNode: output.toNode,
            toPort: output.toPort,
            priorityTier: ranks.outputRanks.get(output.id) ?? 0,
            sourceEdgeIds: { input: originalInputId(input), output: originalOutputId(output) },
          });
        }
      } else if (outputs.length === 1) {
        const output = outputs[0]!;
        for (const input of inputs) {
          additions.push({
            id: `sp:${input.id}>${output.id}`,
            part,
            fromNode: input.fromNode,
            fromPort: input.fromPort,
            toNode: output.toNode,
            toPort: output.toPort,
            priorityTier: ranks.inputRanks.get(input.id) ?? 0,
            sourceEdgeIds: { input: originalInputId(input), output: originalOutputId(output) },
          });
        }
      } else {
        // Multiple on BOTH sides — `resolveRanks` was expected to report
        // this as `"unsupported"` itself; treated the same way here as a
        // defensive fallback (never silently crossbar).
        unsupportedNodeIds.add(node.id);
      }
    }

    // Fold this node away: drop every edge that touched it (whether or not
    // a replacement was produced — a dangling or unsupported part-group's
    // edges are dropped with nothing to replace them, same as before this
    // pass) and splice in whatever this fold minted, so the NEXT node
    // processed sees it as an ordinary incident edge.
    const replaced = new Set(incident);
    pool = [...pool.filter((e) => !replaced.has(e)), ...additions];
  }

  return { edges: pool.filter(isSynthetic), unsupportedNodeIds };
}
