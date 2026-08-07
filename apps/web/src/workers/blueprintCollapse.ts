// Job 026 (Blueprints, PLAN.md §10.3): the container-aware glue that turns a
// `kind: "blueprint"` container's internal recipe subgraph into ONE
// synthetic `SolverNode` (a "blueprint compound node", `@scm/solver`'s
// `SolverNode.blueprintCopyBasis`) before the document-wide snapshot ever
// reaches the solver — the same "erase the unrepresentable thing, rewrite
// its incident edges, let the EXISTING solver machinery do the rest" pattern
// Job 024 established for the Splurger node type (`splurgerPassthrough.ts`),
// generalized to a whole SUBGRAPH instead of a single routing point.
//
// ---------------------------------------------------------------------------
// HOW PLAN.md §10.3 IS RESOLVED — read this before touching anything below.
// See jobs/026-blueprints.md's Handoff notes for the full write-up; this is
// the short version colocated with the code it describes.
// ---------------------------------------------------------------------------
//
// The copy count is NOT a post-multiply bolted on after an independent
// solve. It is represented as an ordinary `SolverNode` whose "machine count"
// IS the copy count — that node participates in the exact same fixed-point
// propagation (`packages/solver/src/basic.ts`/`full.ts`) as every real
// recipe node, resolved from whichever neighbor's demand crosses the
// blueprint's boundary, with ZERO changes to either of those modules (see
// `packages/solver/src/nodeProfile.ts`'s `buildBlueprintCompoundProfile` —
// the only `@scm/solver` change this job made). A downstream/upstream node
// that's itself unresolved sees the compound's OWN resolved rate propagate
// onward exactly as it would from a real node — the copy count is a genuine
// joint-solve variable, not a value computed in isolation and multiplied in
// afterward.
//
// What THIS module does is compute that compound node's "per copy" rates —
// i.e. its `Recipe.Parts`-equivalent — by solving the blueprint's OWN
// internal subgraph ONCE, in isolation, using whichever internal node has
// the user-placed "defining" limit (PLAN.md §2's "put a limit on something
// inside to define one copy") exactly as authored. This inner solve needs NO
// new solver capability — it is precisely what a normal `solve()` call over
// that container's own contents already produces. The outer, whole-document
// solve then determines the copy count from ACTUAL external demand, exactly
// the same derived-boundary-port mechanism Job 013 already built for
// outposts generally (`outposts/portMapping.ts`'s `isContainerWithinSubtree`
// is reused directly below for internal/crossing classification).
//
// HOW THE COMPOUND'S PER-COPY RATES ARE COMPUTED, and why this is EXACT (not
// an approximation): the one-copy sub-solve's own `SolveSummary.perPart`
// (`@scm/solver`'s made/used/unmade/unused BALANCE across every node in a
// snapshot — see `packages/solver/src/summary.ts`'s own header) already IS
// "how much of this part crosses the blueprint's boundary, per copy" for
// free: `unused` (production with no matching internal consumption) is
// exactly the net amount that MUST leave the blueprint; `unmade` (demand
// with no matching internal production) is exactly the net amount that MUST
// enter it. This is a pure per-NODE aggregate (`partRateAtMachineCount`
// summed over every internal node, independent of which specific edges
// route it — see `summary.ts`), so it needs no per-edge lookup at all, and
// sidesteps a real trap: an `EdgeSolveResult` for a boundary-crossing edge
// can NEVER be read directly from this inner solve (`validateEdge` reports
// ANY edge whose other endpoint has no profile as unconditionally invalid/
// zero — see `edgeValidation.ts` — and the external endpoint genuinely has
// no profile inside a one-copy solve of JUST the internal subgraph). Using
// the summary balance instead avoids that trap entirely. Crossing edges are
// still INCLUDED in the one-copy sub-snapshot (see `subSnapshot` below) for
// a different, necessary reason: an internal node with BOTH an internal
// sibling AND a crossing sibling of the same part must still divide its
// production across ALL of them (Basic's even-split / Full's water-fill),
// so the OTHER internal sibling's own rate comes out correct — omitting the
// crossing edge would silently over-allocate to whichever internal sibling
// remained.
//
// KNOWN LIMITATIONS (flagged, not silently papered over):
//   1. NESTED blueprints (a blueprint containing another blueprint, at any
//      depth) are NOT collapsed at all — `isTopLevelBlueprint` below detects
//      this and skips both, leaving their internal nodes/edges flowing
//      through the outer snapshot uncollapsed (same as a plain outpost would
//      today). See jobs/026-blueprints.md's Handoff notes for why a fully
//      general recursive treatment was judged out of scope for this job.
//   2. `Container.copiesLimit`, when set, is encoded as an ordinary
//      `SolverNode.limit`/`"machines"` PIN on the compound node — reusing
//      the exact pin-vs-propagate mechanism every other node already has
//      (see `schema.ts`'s own "caps how many instances may be placed"
//      comment) rather than inventing a second, solver-wide "soft cap"
//      concept. If actual demand needs more copies than the cap, the
//      boundary edges correctly report a rate mismatch — exactly like any
//      other over-constrained pinned node already does.
import type { Container, NodeRecord } from "@scm/ydoc";
import {
  solve,
  type EdgeSolveResult,
  type NodeSolveResult,
  type SolveResult,
  type SolverEdge,
  type SolverMode,
  type SolverNode,
  type SolverSnapshot,
} from "@scm/solver";
import { ONE, ZERO, isZero, parseRational, subtract, toApproximateNumber, toFractionString, multiply, type Rational } from "@scm/rational";
import type { GameData } from "@scm/gamedata";

import { buildContainerParentMap, isContainerWithinSubtree, type ContainerParentMap } from "../canvas/outposts/portMapping";

export function blueprintCompoundNodeId(containerId: string): string {
  return `bp:${containerId}`;
}

/**
 * What `apps/web/src/workers/useSolver.ts` needs, per collapsed blueprint,
 * to later "expand" the outer solve's compound-node result back into
 * correctly-scaled entries for each real internal node/edge (so a user who
 * drills into the blueprint sees THEIR own actual, copies-scaled machine
 * counts, not the compound's aggregate) — see `expandBlueprintResults`.
 */
export interface BlueprintDisplayInfo {
  readonly containerId: string;
  readonly compoundNodeId: string;
  /** The one-copy sub-solve's own result for this blueprint's internal nodes/edges ONLY (crossing edges are excluded here — they already have real, correctly-scaled entries in the outer result via the rewritten compound edges, which keep their original ids). */
  readonly perCopy: {
    readonly nodes: readonly NodeSolveResult[];
    readonly edges: readonly EdgeSolveResult[];
  };
}

export interface BlueprintCollapseResult {
  readonly snapshot: SolverSnapshot;
  readonly blueprints: readonly BlueprintDisplayInfo[];
  /** Blueprint container ids skipped because they're nested inside (or contain) another blueprint — see this module's header, limitation 1. */
  readonly skippedNestedBlueprintIds: readonly string[];
}

function isTopLevelBlueprint(container: Container, containersById: ReadonlyMap<string, Container>, parentOf: ContainerParentMap): boolean {
  // No blueprint ancestor...
  let current = container.parentId;
  while (current !== null) {
    if (containersById.get(current)?.kind === "blueprint") return false;
    current = parentOf.get(current) ?? null;
  }
  // ...and no blueprint descendant.
  for (const other of containersById.values()) {
    if (other.id === container.id || other.kind !== "blueprint") continue;
    if (isContainerWithinSubtree(other.id, container.id, parentOf)) return false;
  }
  return true;
}

type EdgeDirection = "outgoing" | "incoming";

/**
 * The compound node's per-part rates, straight from the one-copy sub-solve's
 * OWN `SolveSummary.perPart` balance — see this module's header for why this
 * (rather than reading any individual boundary-crossing edge's own
 * `EdgeSolveResult.rate`) is the exact, trap-free way to get this number:
 * `unused` = net production with nowhere internal to go (must leave the
 * blueprint, i.e. this compound's OUTGOING/positive rate); `unmade` = net
 * demand with no internal source (must enter the blueprint, i.e. this
 * compound's INCOMING/negative rate). At most one of the two is ever
 * nonzero for a given part (by `computeSummary`'s own `max(0, ...)`
 * definition), so the signed combination below is always unambiguous.
 */
function perCopyRatesFromSummary(perPart: Readonly<Record<string, { unused: string; unmade: string }>>): Record<string, string> {
  const perCopyRates: Record<string, string> = {};
  for (const [part, balance] of Object.entries(perPart)) {
    const net = subtract(parseRational(balance.unused), parseRational(balance.unmade));
    if (!isZero(net)) perCopyRates[part] = toFractionString(net);
  }
  return perCopyRates;
}

/**
 * Collapses every top-level `kind: "blueprint"` container found in
 * `containers` into a single compound `SolverNode` inside `rawSnapshot` —
 * `rawSnapshot` is `buildSnapshot.ts`'s ALREADY-flattened, recipe-only,
 * Splurger-passed-through snapshot (this module never touches container
 * boundaries for any other purpose than blueprints; a plain outpost's
 * internal nodes flow through completely untouched, per this job's own
 * out-of-scope note). `mode` gates whether collapsing happens at all — None
 * and Manual mode have no "infer a value from the graph" concept (PLAN.md
 * §2's table), so a blueprint's internal nodes are left exactly as they'd
 * render for a plain outpost in either of those modes; only Basic/Full
 * mode's propagation is what "copies" needs.
 */
export function collapseBlueprints(
  containers: readonly Container[],
  nodes: readonly NodeRecord[],
  rawSnapshot: SolverSnapshot,
  mode: SolverMode,
  gameData: GameData,
): BlueprintCollapseResult {
  const blueprintContainers = containers.filter((c) => c.kind === "blueprint");
  if (blueprintContainers.length === 0 || (mode !== "basic" && mode !== "full")) {
    return { snapshot: rawSnapshot, blueprints: [], skippedNestedBlueprintIds: [] };
  }

  const containersById = new Map(containers.map((c) => [c.id, c] as const));
  const parentOf = buildContainerParentMap(containers);
  const containerIdByNodeId = new Map(nodes.map((n) => [n.id, n.containerId] as const));

  const eligible: Container[] = [];
  const skippedNestedBlueprintIds: string[] = [];
  for (const container of blueprintContainers) {
    if (isTopLevelBlueprint(container, containersById, parentOf)) eligible.push(container);
    else skippedNestedBlueprintIds.push(container.id);
  }
  if (eligible.length === 0) {
    return { snapshot: rawSnapshot, blueprints: [], skippedNestedBlueprintIds };
  }

  const solverNodeById = new Map(rawSnapshot.nodes.map((n) => [n.id, n] as const));
  const consumedNodeIds = new Set<string>();
  const consumedEdgeIds = new Set<string>();
  const blueprints: BlueprintDisplayInfo[] = [];
  const compoundNodes: SolverNode[] = [];
  const rewrittenCrossingEdges: SolverEdge[] = [];

  for (const container of eligible) {
    const isInternal = (nodeId: string) => {
      const containerId = containerIdByNodeId.get(nodeId);
      return containerId !== undefined && isContainerWithinSubtree(containerId, container.id, parentOf);
    };

    const internalNodes = rawSnapshot.nodes.filter((n) => isInternal(n.id));
    if (internalNodes.length === 0) continue; // an empty blueprint has nothing to collapse — leave it be.

    const internalEdges: SolverEdge[] = [];
    const crossing: { edge: SolverEdge; direction: EdgeDirection }[] = [];
    for (const edge of rawSnapshot.edges) {
      const fromInside = isInternal(edge.fromNode);
      const toInside = isInternal(edge.toNode);
      if (fromInside && toInside) internalEdges.push(edge);
      else if (fromInside) crossing.push({ edge, direction: "outgoing" });
      else if (toInside) crossing.push({ edge, direction: "incoming" });
    }

    // The one-copy sub-solve: the blueprint's own internal nodes/edges,
    // PLUS the crossing edges (with their real external endpoint id, even
    // though that node has no profile in this sub-snapshot — both Basic and
    // Full mode treat an unresolved/absent other-endpoint as simply
    // "uncapped from this side," which is exactly right for "what's
    // available from one copy in isolation"). The defining limit, wherever
    // the user placed it inside the blueprint, is used exactly as authored
    // — no new solver concept, just an ordinary `solve()` call.
    const subSnapshot: SolverSnapshot = {
      nodes: internalNodes,
      edges: [...internalEdges, ...crossing.map((c) => c.edge)],
    };
    const oneCopyResult = solve(subSnapshot, mode, gameData);

    const perCopyRates = perCopyRatesFromSummary(oneCopyResult.summary.perPart);
    const perCopyPowerMW = oneCopyResult.nodes.reduce((sum, n) => sum + n.power, 0);

    const compoundId = blueprintCompoundNodeId(container.id);
    const hasCap = container.copiesLimit !== null && container.copiesLimit !== undefined;
    compoundNodes.push({
      id: compoundId,
      recipe: "",
      machine: "",
      purity: null,
      // Job 026: `Container.copiesLimit` ("caps how many instances may be
      // placed" — packages/ydoc/src/schema.ts) is encoded as a literal
      // machine-count PIN, exactly the mechanism every other node's own
      // `limit` field already uses — see this module's header, limitation 3.
      limit: hasCap ? String(container.copiesLimit) : null,
      limitMode: "machines",
      clock: null,
      shards: 0,
      blueprintCopyBasis: { perCopyRates, perCopyPowerMW },
    });

    for (const { edge } of crossing) {
      const internalIsFrom = isInternal(edge.fromNode);
      rewrittenCrossingEdges.push({
        ...edge,
        fromNode: internalIsFrom ? compoundId : edge.fromNode,
        toNode: internalIsFrom ? edge.toNode : compoundId,
      });
      consumedEdgeIds.add(edge.id);
    }
    for (const internalEdge of internalEdges) consumedEdgeIds.add(internalEdge.id);
    for (const internalNode of internalNodes) consumedNodeIds.add(internalNode.id);

    blueprints.push({
      containerId: container.id,
      compoundNodeId: compoundId,
      perCopy: {
        nodes: oneCopyResult.nodes.filter((n) => solverNodeById.has(n.nodeId) && isInternal(n.nodeId)),
        edges: oneCopyResult.edges.filter((e) => internalEdges.some((ie) => ie.id === e.edgeId)),
      },
    });
  }

  const snapshot: SolverSnapshot = {
    nodes: [...rawSnapshot.nodes.filter((n) => !consumedNodeIds.has(n.id)), ...compoundNodes],
    edges: [...rawSnapshot.edges.filter((e) => !consumedEdgeIds.has(e.id)), ...rewrittenCrossingEdges],
  };

  return { snapshot, blueprints, skippedNestedBlueprintIds };
}

/**
 * Merges a raw (compound-node-bearing) `SolveResult` with every collapsed
 * blueprint's one-copy sub-solve into the FINAL result `useSolver.ts`
 * exposes: the compound's own entry stays (so a blueprint's parent-view card
 * can read "Copies: N" off it directly, via `nodeResultById.get(
 * blueprintCompoundNodeId(containerId))`), AND every internal node/edge gets
 * its own entry back under its REAL id, scaled by the solved copy count —
 * `machineCount`/`partRates`/`power`/`rate` all multiplied by `copies`,
 * `valid`/`issues` carried through unchanged (scaling both sides of a valid
 * match, or an invalid mismatch, by the same positive scalar preserves
 * exactly which one it was). The document-wide `summary`/`valid`/`warnings`
 * are recomputed from the EXPANDED list with the compound excluded (its own
 * aggregate boundary-only rates would otherwise double-count every
 * internal-only part alongside the internal nodes' own full contribution)
 * but the compound's own issues (e.g. a `copiesLimit` mismatch) still fold
 * into `warnings`/`valid`.
 */
export type MergeComponentResults = (
  mode: SolverMode,
  components: readonly { nodes: readonly NodeSolveResult[]; edges: readonly EdgeSolveResult[] }[],
) => SolveResult;

export function expandBlueprintResults(
  result: SolveResult,
  blueprints: readonly BlueprintDisplayInfo[],
  mergeComponentResults: MergeComponentResults,
): SolveResult {
  if (blueprints.length === 0) return result;

  const compoundIds = new Set(blueprints.map((b) => b.compoundNodeId));
  const nonCompoundNodes = result.nodes.filter((n) => !compoundIds.has(n.nodeId));
  const compoundNodes = result.nodes.filter((n) => compoundIds.has(n.nodeId));

  const extraNodes: NodeSolveResult[] = [];
  const extraEdges: EdgeSolveResult[] = [];
  for (const bp of blueprints) {
    const compound = compoundNodes.find((n) => n.nodeId === bp.compoundNodeId);
    const copies = compound ? parseRational(compound.machineCount) : ONE;
    const copiesResolved = compound?.resolved ?? false;
    for (const n of bp.perCopy.nodes) extraNodes.push(scaleNodeResult(n, copies, copiesResolved));
    for (const e of bp.perCopy.edges) extraEdges.push(scaleEdgeResult(e, copies));
  }

  const summaryComponent = mergeComponentResults(result.mode, [
    { nodes: [...nonCompoundNodes, ...extraNodes], edges: [...result.edges, ...extraEdges] },
  ]);

  return {
    ...summaryComponent,
    nodes: [...summaryComponent.nodes, ...compoundNodes].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)),
    valid: summaryComponent.valid && compoundNodes.every((n) => n.valid),
    warnings: [...summaryComponent.warnings, ...compoundNodes.flatMap((n) => n.issues)],
  };
}

function scaleRate(rateString: string, copies: Rational): string {
  const value = parseRational(rateString);
  return toFractionString(isZero(value) ? ZERO : multiply(value, copies));
}

function scaleNodeResult(perCopy: NodeSolveResult, copies: Rational, copiesResolved: boolean): NodeSolveResult {
  const partRates: Record<string, string> = {};
  for (const [part, rate] of Object.entries(perCopy.partRates)) {
    partRates[part] = scaleRate(rate, copies);
  }
  return {
    ...perCopy,
    machineCount: scaleRate(perCopy.machineCount, copies),
    partRates,
    power: perCopy.power * toApproximateNumber(copies),
    resolved: perCopy.resolved && copiesResolved,
  };
}

function scaleEdgeResult(perCopy: EdgeSolveResult, copies: Rational): EdgeSolveResult {
  return { ...perCopy, rate: scaleRate(perCopy.rate, copies) };
}
