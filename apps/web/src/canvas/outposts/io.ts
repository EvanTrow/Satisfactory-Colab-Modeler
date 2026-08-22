// Outpost rework: the two permanent, non-removable pass-through
// nodes every outpost container gets — one for external inputs,
// one for external outputs. Dragging a connection directly onto the outer
// boundary card (`OutpostNode.tsx`) is redirected
// (`edges/connectionLogic.ts`'s `resolveEdgeEndpoints`) to land on one of
// these two REAL `NodeRecord`s instead of the container id itself — see
// this job's plan doc for the full "why". They're rendered inside the
// container by `OutpostIoNode.tsx`, and erased into direct recipe-to-recipe
// edges before the solver ever sees them by reusing
// `workers/splurgerPassthrough.ts`'s existing, fully generic rewrite
// (`buildSnapshot.ts`).
//
// Ids are DETERMINISTIC (derived from the container id), not randomly
// generated, so two clients racing to backfill the same legacy container
// (see `useYjsSync.ts`'s one-time backfill effect) converge on the same
// record via ordinary Yjs CRDT idempotency instead of creating duplicates.
import { add, parseRational, type Rational } from "@scm/rational";
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import { addNode, getNode, type EdgeRecord, type SfmDocument } from "@scm/ydoc";

export const OUTPOST_INPUT_KIND = "outpost-input";
export const OUTPOST_OUTPUT_KIND = "outpost-output";

/** The "cannot be removed/moved out of its container" guard set — consulted by `useSelectionKeybinds.ts` (delete/cut) and `NodeContextMenu.tsx` (move-to-container, quick settings). */
export const LOCKED_NODE_KINDS: ReadonlySet<string> = new Set([OUTPOST_INPUT_KIND, OUTPOST_OUTPUT_KIND]);

export function outpostInputNodeId(containerId: string): string {
  return `io-in:${containerId}`;
}

export function outpostOutputNodeId(containerId: string): string {
  return `io-out:${containerId}`;
}

export function isOutpostIoKind(kind: string): boolean {
  return kind === OUTPOST_INPUT_KIND || kind === OUTPOST_OUTPUT_KIND;
}

/**
 * Which parts are wired on only ONE side of a locked pass-through node —
 * the solver has nowhere to route these (no synthetic edge is produced,
 * `workers/splurgerPassthrough.ts`'s header), so they never get a rate.
 * `internalDirection` is which side of `ioNodeId` faces INTO the container
 * ("out" for the Inputs node, feeding internal consumers; "in" for the
 * Outputs node, fed by internal producers — see `OutpostIoNode.tsx`'s own
 * `internalDirection`). Shared by `OutpostIoNode.tsx` (the internal card,
 * which already had this exact per-part-set comparison) and
 * `OutpostNode.tsx` (the OUTER boundary card, which
 * couldn't tell a "genuinely no rate yet" port apart from a "half-wired,
 * waiting on the other side" one without this) so the two views can never
 * disagree about which parts are dangling.
 */
export function computeIoDanglingParts(
  edges: readonly EdgeRecord[],
  ioNodeId: string,
  internalDirection: "in" | "out",
): ReadonlySet<string> {
  const internalParts = new Set(
    edges
      .filter((edge) => (internalDirection === "in" ? edge.toNode === ioNodeId : edge.fromNode === ioNodeId))
      .map((edge) => edge.part),
  );
  const externalParts = new Set(
    edges
      .filter((edge) => (internalDirection === "in" ? edge.fromNode === ioNodeId : edge.toNode === ioNodeId))
      .map((edge) => edge.part),
  );
  return new Set(
    [...new Set([...internalParts, ...externalParts])].filter((part) => internalParts.has(part) !== externalParts.has(part)),
  );
}

export interface IoPortRow {
  readonly part: string;
  readonly edgeIds: readonly string[];
}

/**
 * Every distinct part currently touching `ioNodeId`, from EITHER side —
 * this is what a card's connectable rows are drawn from, both
 * `OutpostIoNode.tsx`'s own internal-facing rows and (as of this rework's
 * follow-up) the OUTER boundary card's own rows. Deliberately NOT gated on
 * "does this part also cross the boundary yet" — a part wired only
 * internally (a producer feeding the Outputs node with nothing external
 * consuming it yet) still needs to show up as an available output, so a
 * user can then drag the other half from outside. `portMapping.ts`'s
 * `computeOutpostPorts` (boundary-CROSSING edges only) is a separate,
 * still-relevant source for the LEGACY "moved a node into the outpost"
 * mechanism, which never touches these locked nodes at all — the outer
 * cards merge both sources.
 */
export function computeIoNodePorts(edges: readonly EdgeRecord[], ioNodeId: string): IoPortRow[] {
  const byPart = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.fromNode !== ioNodeId && edge.toNode !== ioNodeId) continue;
    const list = byPart.get(edge.part);
    if (list) list.push(edge.id);
    else byPart.set(edge.part, [edge.id]);
  }
  return [...byPart.entries()]
    .map(([part, edgeIds]) => ({ part, edgeIds }))
    .sort((a, b) => a.part.localeCompare(b.part));
}

/**
 * The rate to show for `part` at `ioNodeId`, preferring a real cross-
 * boundary solved rate and falling back to the OTHER (real) endpoint's own
 * produced/consumed rate when no complete circuit exists yet for ANY edge
 * of this part (the "only wired on one side" case `computeIoDanglingParts`
 * flags) — otherwise a half-wired output like "a Heat Sink producer feeding
 * the Outputs node, nothing external consuming it yet" would show no number
 * at all even though the produced amount is already known.
 *
 * The two tiers are never mixed for one part: if ANY edge resolved to a
 * real (aliased) `EdgeSolveResult` (`useSolver.ts`'s `indexEdges`), only
 * those are summed, deduplicated by object identity — a complete 1-to-1
 * circuit's internal and external edges both alias to the exact SAME result
 * object (see that module's own aliasing loop), so naively summing "one
 * value per edge" would double-count it; for a splitter/merger shape, each
 * individual many-side edge aliases to its OWN distinct object, so summing
 * the distinct set is exactly the total crossing this boundary. Only when
 * NOTHING resolved at all (genuinely no complete circuit for this part) does
 * this fall through to the per-edge node-rate fallback, which is safe from
 * that same double-counting risk precisely because nothing resolved — by
 * construction every edge in that case sits on the SAME side, each pointing
 * at a DIFFERENT real node, never at each other.
 */
export function computeIoPartRate(
  edges: readonly EdgeRecord[],
  ioNodeId: string,
  part: string,
  edgeResultById: ReadonlyMap<string, EdgeSolveResult>,
  nodeResultById: ReadonlyMap<string, NodeSolveResult>,
): Rational | null {
  const touching = edges.filter(
    (edge) => (edge.fromNode === ioNodeId || edge.toNode === ioNodeId) && edge.part === part,
  );

  const seenResults = new Set<EdgeSolveResult>();
  let resolvedTotal: Rational | null = null;
  for (const edge of touching) {
    const result = edgeResultById.get(edge.id);
    if (!result || seenResults.has(result)) continue;
    seenResults.add(result);
    const rate = parseRational(result.rate);
    resolvedTotal = resolvedTotal ? add(resolvedTotal, rate) : rate;
  }
  if (resolvedTotal) return resolvedTotal;

  let fallbackTotal: Rational | null = null;
  for (const edge of touching) {
    const otherNodeId = edge.fromNode === ioNodeId ? edge.toNode : edge.fromNode;
    const rate = nodeResultById.get(otherNodeId)?.partRates[part];
    if (rate === undefined) continue;
    const parsed = parseRational(rate);
    fallbackTotal = fallbackTotal ? add(fallbackTotal, parsed) : parsed;
  }
  return fallbackTotal;
}

/**
 * Creates whichever of the two locked pass-through nodes `containerId` is
 * still missing, inside one transaction. Idempotent — safe to call on every
 * outpost creation AND, separately, as a one-time backfill for
 * documents that predate this feature (`useYjsSync.ts`).
 */
export function ensureOutpostIoNodes(sfmDoc: SfmDocument, containerId: string, color: string): void {
  sfmDoc.doc.transact(() => {
    const inputId = outpostInputNodeId(containerId);
    if (!getNode(sfmDoc, inputId)) {
      addNode(sfmDoc, {
        id: inputId,
        containerId,
        kind: OUTPOST_INPUT_KIND,
        recipe: null,
        machine: null,
        x: -260,
        y: 0,
        title: "Inputs",
        color,
        limit: null,
        limitMode: "machines",
        clock: null,
        autoRound: true,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: null,
        splurgerVariant: null,
      });
    }
    const outputId = outpostOutputNodeId(containerId);
    if (!getNode(sfmDoc, outputId)) {
      addNode(sfmDoc, {
        id: outputId,
        containerId,
        kind: OUTPOST_OUTPUT_KIND,
        recipe: null,
        machine: null,
        x: 260,
        y: 0,
        title: "Outputs",
        color,
        limit: null,
        limitMode: "machines",
        clock: null,
        autoRound: true,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: null,
        splurgerVariant: null,
      });
    }
  });
}
