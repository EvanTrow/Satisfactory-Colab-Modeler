// Full mode: PLAN.md's Full row — "entered values are limits" (the same
// convention Basic mode uses), but flow through splitters/mergers is
// modeled honestly instead of Basic's flat even-divide-by-sibling-count
// stand-in (Job 017's own Handoff notes: "the even-split edgeGroups.ts
// helpers are NOT what Full mode should reuse for priority splitting, ...").
// Full mode adds two things Basic explicitly does not model:
//   - EVEN-SPLIT PREFERENCE: a splitter/merger's sibling edges split as
//     evenly as possible, but yield to a sibling's own hard capacity (a
//     resolved neighbor's fixed rate) when it can't absorb/supply an equal
//     share — the remainder redistributes among the siblings that still can.
//   - TWO-TIER PRIORITY: an edge tagged `priorityTier: "bottom"`
//     (`snapshot.ts`) only receives whatever's left over once every "top"
//     sibling has taken its full share — "top drains first, bottom takes
//     overflow." When an edge has no EXPLICIT tag, its tier is INFERRED
//     (`inferredTier` below): an edge whose other endpoint has a `limit` set
//     (a fixed, finite demand/supply) defaults to "top"; one whose other
//     endpoint has no limit (open-ended — e.g. an "unlimited" AWESOME
//     Sink/Dimensional Depot) defaults to "bottom". This makes an explicitly
//     limited node's demand get satisfied first from any shared source,
//     ahead of unlimited siblings, without the user having to place a
//     dedicated Priority Splitter/Merger — see `inferredTier`'s own doc
//     comment.
// Both are the SAME algorithm — max-min-fair water-filling, lexicographic
// across the two tiers — implemented once in `waterFill.ts` and applied
// once per (node, part, direction) sibling GROUP per propagation pass. See
// `waterFill.ts`'s own header for the exact LP this solves and why a
// closed-form algorithm is used instead of a generic simplex tableau.
//
// ---------------------------------------------------------------------------
// ARCHITECTURE — deliberately parallel to `basic.ts`; read that file's
// header first if you haven't
// ---------------------------------------------------------------------------
// 1. PIN: identical to Basic — every `limit !== null` node gets an
//    immediate machine count from `nodeProfile.ts`'s `pinnedMachineCount`.
// 2. GROUP: `buildSplitGroups` partitions every edge into the (up to) two
//    sibling groups it belongs to — one "outgoing" group owned by its
//    `fromNode` (that node acting as a splitter for `edge.part`) and one
//    "incoming" group owned by its `toNode` (that node acting as a merger).
//    This is pure topology and does not change pass to pass.
// 3. PROPAGATE (`propagateMachineCountsFull`): a Jacobi-style fixed-point
//    relaxation, structurally the same as Basic's `propagateMachineCounts`
//    — but where Basic divides a resolved neighbor's rate evenly by raw
//    sibling COUNT, Full mode computes, once per pass per resolved-owner
//    group, the real `waterFillGroup` allocation across that group's
//    siblings (using the PREVIOUS pass's frozen resolved set for every
//    sibling's cap — the same Jacoby discipline Basic uses, so within-pass
//    scan order still can't matter), then looks up each unresolved node's
//    own incident edges' shares from those precomputed group allocations.
// 4. FALLBACK: identical to Basic — anything still unresolved after the
//    fixed point defaults to exactly `ONE` machine, `resolved: false`.
// 5. FINALIZE: one more group-allocation pass, over the FULLY resolved
//    final counts (including fallback defaults), produces the shares used
//    for `EdgeSolveResult.rate`/`.valid` — mirroring Basic's
//    `validateEdge`: an edge is invalid when its source-side share and
//    target-side share disagree.
//
// DETERMINISM: see `waterFill.ts`'s own note — every round saturates ALL
// under-cap candidates in that round simultaneously, and exact `Rational`
// division never leaves a remainder, so, exactly as `basic.ts` established
// for its even-split case, iteration/array order cannot affect the
// arithmetic. Every node/edge/part id list this module builds is sorted via
// `ordering.ts`'s `idCompare` before use. See `fullDeterminism.test.ts`.
//
// A DOCUMENTED SCOPE LIMITATION — flagged prominently in
// jobs/023-full-calculator.md's Handoff notes, not hidden here: a sibling
// group's cap for edge `e` uses the OTHER endpoint's own TOTAL resolved
// rate for that part, not a recursively-computed "what that node's OWN
// splitter/merger group would actually route through THIS specific edge."
// This is always a CORRECT bound (it never lets this module over-allocate
// beyond what the neighbor could possibly need/supply in total), but it is
// not always the TIGHTEST possible bound when two splitter/merger points
// sit directly adjacent on the same part (e.g. a splitter feeding directly
// into a node that is simultaneously a merger for the same part, drawing
// from multiple sources at once). Every hand-derived benchmark in
// `full.golden.test.ts` uses a single splitter or merger point at a time
// (matching this job's acceptance criteria and Basic mode's own precedent
// of not attempting a fully general simultaneous-graph solve), where this
// bound is always exact. A fully general treatment would require solving
// every splitter/merger's allocation jointly (a single graph-wide LP)
// rather than this module's per-group, pass-propagated approach.
//
// CANCELLATION/PROGRESS: every pass of the outer relaxation loop, AND every
// round of every `waterFillGroup` call within it, checks `options.signal`
// and reports `options.onProgress` — see `FullSolveOptions`'s own doc
// comment below and jobs/023-full-calculator.md's Handoff notes for exactly
// how Job 018's worker host should wire this through `postMessage`.
import { ONE, ZERO, abs, add, equals, isNegative, isPositive, isZero, negate, toFractionString, type Rational } from "@scm/rational";
import type { GameData } from "@scm/gamedata";
import { resolveEdgesJointly, sourceKey, targetKey } from "./edgeResolution";
import { groupConnectedComponents, type JointFlowEdge } from "./jointFlow";
import { buildNodeProfile, machineCountForTargetRate, partRateAtMachineCount, pinnedMachineCount, type NodeProfile } from "./nodeProfile";
import { buildNodeResult } from "./nodeResult";
import { idCompare, sortedIds } from "./ordering";
import type { SolveResult } from "./result";
import type { PriorityTier, SolverEdge, SolverSnapshot } from "./snapshot";
import { computeSummary } from "./summary";
import { SolveCancelledError, waterFillGroup, type CancellationSignal, type ShareCandidate } from "./waterFill";

export { SolveCancelledError };
export type { CancellationSignal, WaterFillProgress } from "./waterFill";

export interface FullProgressInfo {
  readonly phase: "propagate" | "finalize";
  readonly pass: number;
  readonly resolvedCount: number;
  readonly totalCount: number;
  /** Set only while a `waterFillGroup` call is iterating within this phase/pass. */
  readonly waterFill?: { readonly tier: PriorityTier; readonly round: number; readonly activeCount: number };
}

export interface FullSolveOptions {
  /**
   * Checked at the start of every propagation pass and every water-fill
   * round (see `waterFill.ts`). When it reports `aborted`, `solveFull`
   * stops promptly — within one round, never after running to completion —
   * and returns a defined cancelled `SolveResult` (`cancelled: true`,
   * empty `nodes`/`edges`, `valid: false`) instead of throwing.
   */
  readonly signal?: CancellationSignal;
  /**
   * Called synchronously, inline, at each checkpoint above. Cheap (a plain
   * object literal) — safe to call every round even on a large graph; a
   * consumer that wants coarser-grained UI updates (Job 024's STOP/progress
   * UI) should throttle on ITS OWN side, since `packages/solver` has no
   * opinion on UI update cadence.
   */
  readonly onProgress?: (info: FullProgressInfo) => void;
}

// ---------------------------------------------------------------------------
// Split/merge group topology.
// ---------------------------------------------------------------------------

type Direction = "outgoing" | "incoming";

interface SplitGroup {
  readonly ownerNode: string;
  readonly part: string;
  readonly direction: Direction;
  readonly edges: readonly SolverEdge[];
}

function groupOwnerKey(nodeId: string, part: string): string {
  return `${nodeId} ${part}`;
}

/**
 * Partitions every edge into the (up to) two sibling groups it belongs to.
 * Pure topology — independent of any node's resolved state, so this is
 * computed once per `solveFull` call and reused across every propagation
 * pass.
 */
function buildSplitGroups(edges: readonly SolverEdge[]): SplitGroup[] {
  const byKey = new Map<string, SolverEdge[]>();
  const metaByKey = new Map<string, { ownerNode: string; part: string; direction: Direction }>();

  for (const edge of edges) {
    const outKey = `outgoing ${groupOwnerKey(edge.fromNode, edge.part)}`;
    metaByKey.set(outKey, { ownerNode: edge.fromNode, part: edge.part, direction: "outgoing" });
    (byKey.get(outKey) ?? byKey.set(outKey, []).get(outKey)!).push(edge);

    const inKey = `incoming ${groupOwnerKey(edge.toNode, edge.part)}`;
    metaByKey.set(inKey, { ownerNode: edge.toNode, part: edge.part, direction: "incoming" });
    (byKey.get(inKey) ?? byKey.set(inKey, []).get(inKey)!).push(edge);
  }

  const groups: SplitGroup[] = [];
  for (const [key, list] of byKey) {
    const meta = metaByKey.get(key)!;
    groups.push({ ...meta, edges: [...list].sort((a, b) => idCompare(a.id, b.id)) });
  }
  groups.sort(
    (a, b) =>
      idCompare(a.ownerNode, b.ownerNode) || idCompare(a.part, b.part) || idCompare(a.direction, b.direction),
  );
  return groups;
}

interface IncidentEdge {
  readonly edge: SolverEdge;
  readonly otherNode: string;
  readonly part: string;
  /** `true` if the node this list was built FOR is `edge.fromNode`. */
  readonly asSource: boolean;
}

function buildIncidence(edges: readonly SolverEdge[]): Map<string, IncidentEdge[]> {
  const incidentByNode = new Map<string, IncidentEdge[]>();
  for (const edge of edges) {
    const fromList = incidentByNode.get(edge.fromNode) ?? [];
    fromList.push({ edge, otherNode: edge.toNode, part: edge.part, asSource: true });
    incidentByNode.set(edge.fromNode, fromList);

    const toList = incidentByNode.get(edge.toNode) ?? [];
    toList.push({ edge, otherNode: edge.fromNode, part: edge.part, asSource: false });
    incidentByNode.set(edge.toNode, toList);
  }
  for (const list of incidentByNode.values()) list.sort((a, b) => idCompare(a.edge.id, b.edge.id));
  return incidentByNode;
}

function checkCancelled(signal: CancellationSignal | undefined): void {
  if (signal?.aborted) throw new SolveCancelledError();
}

/**
 * `edge`'s effective priority tier for a group where `otherNode` is the
 * OTHER endpoint (the target for an outgoing/splitter group, the source for
 * an incoming/merger group) — `edge.priorityTier` if the user explicitly set
 * one, else INFERRED from whether `otherNode` has an explicit `limit` set.
 *
 * A node with `limit !== null` has a fixed, finite demand/supply (Basic
 * mode's own "pin" concept — see `nodeProfile.ts`'s `pinnedMachineCount`)
 * that plain max-min-fair water-filling would otherwise only partially
 * satisfy whenever an unbounded sibling (no limit — e.g. an AWESOME
 * Sink/Dimensional Depot set to "unlimited", or a node that hasn't resolved
 * yet) is in the same pool: fairness alone gives the limited sibling an
 * equal share even when its own cap sits ABOVE that share, instead of
 * routing it its full, already-known demand first. Defaulting a limited
 * neighbor to `"top"` and an unlimited one to `"bottom"` makes every
 * explicitly-limited node drain/fill first — "nodes with a machine limit set
 * always get priority, even if that leaves nothing for unlimited siblings" —
 * with NO change for a group where every sibling is limited (all `"top"`,
 * still fair-shared among themselves) or every sibling is unlimited (all
 * `"bottom"`, i.e. still just one pool, identical to the old undifferentiated
 * default).
 */
function inferredTier(
  edge: SolverEdge,
  otherNode: string,
  profiles: ReadonlyMap<string, NodeProfile>,
): PriorityTier {
  if (edge.priorityTier) return edge.priorityTier;
  return profiles.get(otherNode)?.node.limit != null ? "top" : "bottom";
}

// ---------------------------------------------------------------------------
// Group allocation — the water-fill call site.
// ---------------------------------------------------------------------------

interface GroupAllocationContext {
  readonly phase: FullProgressInfo["phase"];
  readonly pass: number;
  readonly resolvedCount: number;
  readonly totalCount: number;
  readonly options: FullSolveOptions;
}

/**
 * Computes, for every group OWNED by an already-resolved node (per the
 * `resolved`/`counts` snapshot passed in — a Jacobi-frozen state, same
 * discipline as `basic.ts`'s `propagateMachineCounts`), that group's
 * water-filled share allocation. Groups owned by an unresolved node are
 * skipped (there's nothing to distribute yet — they'll be computed in a
 * later pass once their owner resolves). Returns the per-group share maps
 * plus any `overflow` amounts keyed by owner node, for advisory issue
 * reporting.
 */
function computeGroupAllocations(
  groups: readonly SplitGroup[],
  profiles: ReadonlyMap<string, NodeProfile>,
  counts: ReadonlyMap<string, Rational>,
  resolved: ReadonlySet<string>,
  ctx: GroupAllocationContext,
): { allocations: Map<SplitGroup, ReadonlyMap<string, Rational>>; overflowByOwner: Map<string, Rational> } {
  const allocations = new Map<SplitGroup, ReadonlyMap<string, Rational>>();
  const overflowByOwner = new Map<string, Rational>();

  for (const group of groups) {
    checkCancelled(ctx.options.signal);
    if (!resolved.has(group.ownerNode)) continue;
    const ownerProfile = profiles.get(group.ownerNode);
    const ownerCount = counts.get(group.ownerNode);
    if (!ownerProfile?.recipe || ownerCount === undefined) continue;

    // The owner's own direction for this group: "outgoing" means the owner
    // is every edge's `fromNode` (a splitter, producing/OUTPUT for this
    // part); "incoming" means it's every edge's `toNode` (a merger,
    // consuming/INPUT). The other endpoint of each edge is always the
    // opposite direction. Passing this disambiguates recipes that list the
    // same part name twice (e.g. Encased Uranium Cell's Sulfuric Acid input
    // vs. its own byproduct) — see `NodeProfile.refRatePerPartByDirection`.
    const ownerDirection = group.direction === "outgoing" ? "output" : "input";
    const otherDirection = group.direction === "outgoing" ? "input" : "output";

    const total = abs(partRateAtMachineCount(ownerProfile, group.part, ownerCount, ownerDirection));
    if (isZero(total)) continue;

    const candidates: ShareCandidate[] = group.edges.map((edge) => {
      const otherNode = group.direction === "outgoing" ? edge.toNode : edge.fromNode;
      let cap: Rational | null = null;
      if (resolved.has(otherNode)) {
        const otherProfile = profiles.get(otherNode);
        const otherCount = counts.get(otherNode);
        if (otherProfile?.recipe && otherCount !== undefined && otherProfile.refRatePerPart.has(group.part)) {
          cap = abs(partRateAtMachineCount(otherProfile, group.part, otherCount, otherDirection));
        }
      }
      return { edgeId: edge.id, cap, tier: inferredTier(edge, otherNode, profiles) };
    });

    const { shares, overflow } = waterFillGroup(total, candidates, {
      signal: ctx.options.signal,
      onRound: ctx.options.onProgress
        ? (p) =>
            ctx.options.onProgress!({
              phase: ctx.phase,
              pass: ctx.pass,
              resolvedCount: ctx.resolvedCount,
              totalCount: ctx.totalCount,
              waterFill: p,
            })
        : undefined,
    });
    allocations.set(group, shares);
    if (isPositive(overflow)) overflowByOwner.set(group.ownerNode, overflow);
  }

  return { allocations, overflowByOwner };
}

// ---------------------------------------------------------------------------
// Propagation.
// ---------------------------------------------------------------------------

export interface FullPropagationResult {
  readonly counts: Map<string, Rational>;
  readonly resolved: Set<string>;
}

export function propagateMachineCountsFull(
  nodeIds: readonly string[],
  profiles: ReadonlyMap<string, NodeProfile>,
  edges: readonly SolverEdge[],
  pinned: ReadonlyMap<string, Rational>,
  options: FullSolveOptions = {},
): FullPropagationResult {
  const groups = buildSplitGroups(edges);
  const incidentByNode = buildIncidence(edges);
  const counts = new Map(pinned);
  const resolved = new Set(pinned.keys());

  let pass = 0;
  let progress = true;
  while (progress) {
    progress = false;
    pass += 1;
    checkCancelled(options.signal);
    options.onProgress?.({ phase: "propagate", pass, resolvedCount: resolved.size, totalCount: nodeIds.length });

    const { allocations } = computeGroupAllocations(groups, profiles, counts, resolved, {
      phase: "propagate",
      pass,
      resolvedCount: resolved.size,
      totalCount: nodeIds.length,
      options,
    });

    const outgoingGroupByOwnerPart = new Map<string, SplitGroup>();
    const incomingGroupByOwnerPart = new Map<string, SplitGroup>();
    for (const group of groups) {
      const key = groupOwnerKey(group.ownerNode, group.part);
      if (group.direction === "outgoing") outgoingGroupByOwnerPart.set(key, group);
      else incomingGroupByOwnerPart.set(key, group);
    }

    const updates = new Map<string, Rational>();
    for (const nodeId of nodeIds) {
      if (resolved.has(nodeId)) continue;
      checkCancelled(options.signal);
      const profile = profiles.get(nodeId);
      if (!profile?.recipe) continue;

      // Group nodeId's own incident edges by part FIRST, so a part can only
      // become an `impliedByPart` candidate once EVERY edge touching nodeId
      // for that part has a resolved counterpart. Without this gate, a node
      // that is itself a splitter for this part (multiple outgoing edges to
      // DIFFERENT downstream targets) would get "resolved" off whichever
      // target happens to resolve first — e.g. a wire producer feeding both
      // a machine-capped assembler AND an unconstrained constructor would
      // lock in the assembler's own small demand as its total output the
      // instant only the assembler side resolved, permanently starving the
      // unconstrained sibling instead of leaving that partial signal for a
      // later pass (or yielding to a genuinely complete signal, like this
      // node's OWN resolved supply side, in the same pass). Each of those
      // per-edge lookups (via the OTHER node's own group) is exact on its
      // own; what was missing was requiring the full sibling set to agree
      // before treating the sum as this node's actual total.
      const incidentsByPart = new Map<string, IncidentEdge[]>();
      for (const incident of incidentByNode.get(nodeId) ?? []) {
        const list = incidentsByPart.get(incident.part);
        if (list) list.push(incident);
        else incidentsByPart.set(incident.part, [incident]);
      }

      // Same known limitation as `basic.ts`'s own `impliedByPart`: keyed by
      // bare part name, so an unpinned node incident on both directions of
      // a recipe's duplicated part name (e.g. Encased Uranium Cell's
      // Sulfuric Acid) would sum two physically-different implied rates
      // together. Doesn't affect Generate Factory (every generated node is
      // pinned, so it never reaches this propagation loop at all).
      const impliedByPart = new Map<string, Rational>();
      for (const [part, incidents] of incidentsByPart) {
        if (!incidents.every((incident) => resolved.has(incident.otherNode))) continue;
        let total = ZERO;
        for (const incident of incidents) {
          // If `nodeId` is the edge's TARGET (asSource=false), the relevant
          // group is the OTHER node's OUTGOING group for this part (the
          // other node is acting as the splitter). If `nodeId` is the edge's
          // SOURCE (asSource=true), the relevant group is the OTHER node's
          // INCOMING group for this part (the other node is acting as the
          // merger, pulling from `nodeId` among possibly-several suppliers).
          const key = groupOwnerKey(incident.otherNode, incident.part);
          const group = incident.asSource ? incomingGroupByOwnerPart.get(key) : outgoingGroupByOwnerPart.get(key);
          const share = group && allocations.get(group)?.get(incident.edge.id);
          if (share === undefined) continue;
          total = add(total, share);
        }
        impliedByPart.set(part, total);
      }
      if (impliedByPart.size === 0) continue;

      // Deterministic pivot — identical rule to `basic.ts`: the recipe's
      // own primary part if it has an implied rate, else the
      // alphabetically-first part name that does.
      const candidateParts = [...impliedByPart.keys()].sort();
      const chosenPart =
        profile.primaryPart && impliedByPart.has(profile.primaryPart.part)
          ? profile.primaryPart.part
          : candidateParts[0]!;
      const impliedMagnitude = impliedByPart.get(chosenPart)!;
      if (isZero(impliedMagnitude)) continue;

      const partEntry = profile.recipe.parts.find((p) => p.part === chosenPart);
      if (!partEntry) continue;
      const signedTarget = isPositive(partEntry.amount) ? impliedMagnitude : negate(impliedMagnitude);
      const count = machineCountForTargetRate(profile, chosenPart, signedTarget);
      if (count && !isNegative(count) && !isZero(count)) {
        updates.set(nodeId, count);
      }
    }

    for (const [nodeId, count] of updates) {
      counts.set(nodeId, count);
      resolved.add(nodeId);
      progress = true;
    }
  }

  return { counts, resolved };
}

// ---------------------------------------------------------------------------
// Top-level entry point.
// ---------------------------------------------------------------------------

function cancelledResult(): SolveResult {
  return {
    mode: "full",
    nodes: [],
    edges: [],
    summary: { perPart: {}, powerMade: 0, powerUsed: 0, powerNet: 0, sinkPoints: "0" },
    valid: false,
    warnings: ["solve cancelled"],
    cancelled: true,
  };
}

export function solveFull(snapshot: SolverSnapshot, gameData: GameData, options: FullSolveOptions = {}): SolveResult {
  try {
    return solveFullInner(snapshot, gameData, options);
  } catch (err) {
    if (err instanceof SolveCancelledError) {
      return cancelledResult();
    }
    throw err;
  }
}

function solveFullInner(snapshot: SolverSnapshot, gameData: GameData, options: FullSolveOptions): SolveResult {
  const nodeIds = sortedIds(snapshot.nodes.map((n) => n.id));
  const profiles = new Map(snapshot.nodes.map((n) => [n.id, buildNodeProfile(n, gameData)] as const));

  const pinned = new Map<string, Rational>();
  const extraIssuesByNode = new Map<string, string[]>();
  const forceInvalidByNode = new Set<string>();

  for (const nodeId of nodeIds) {
    const profile = profiles.get(nodeId)!;
    if (!profile.recipe) continue;
    const result = pinnedMachineCount(profile);
    if (result.count) {
      pinned.set(nodeId, result.count);
    } else if (result.issue) {
      extraIssuesByNode.set(nodeId, [result.issue]);
      forceInvalidByNode.add(nodeId);
    }
  }

  const { counts, resolved } = propagateMachineCountsFull(nodeIds, profiles, snapshot.edges, pinned, options);

  const resolvedFlagByNode = new Map<string, boolean>();
  for (const nodeId of nodeIds) {
    if (resolved.has(nodeId)) {
      resolvedFlagByNode.set(nodeId, true);
      continue;
    }
    counts.set(nodeId, ONE);
    resolvedFlagByNode.set(nodeId, false);
    if (!forceInvalidByNode.has(nodeId)) {
      const existing = extraIssuesByNode.get(nodeId) ?? [];
      extraIssuesByNode.set(nodeId, [...existing, "no limit and no resolvable neighbor — defaulted to 1 machine"]);
    }
  }

  checkCancelled(options.signal);

  // FINALIZE: one more group-allocation pass, over the fully resolved final
  // counts (fallback defaults included — every node now has SOME count),
  // for edge rate/validity reporting.
  const groups = buildSplitGroups(snapshot.edges);
  const fullyResolved = new Set(nodeIds);
  const { allocations: finalAllocations, overflowByOwner } = computeGroupAllocations(
    groups,
    profiles,
    counts,
    fullyResolved,
    { phase: "finalize", pass: 0, resolvedCount: nodeIds.length, totalCount: nodeIds.length, options },
  );

  for (const [ownerNode, overflow] of overflowByOwner) {
    // Non-invalidating (matches `basic.ts`'s "no limit and no resolvable
    // neighbor" precedent) — this is a genuine over/under-capacity
    // condition, but the same information is already reflected, without
    // double-penalizing anything, in `summary.ts`'s made/used/unmade/unused
    // balance; this issue exists purely so a Full-mode-specific cause
    // ("your priority split/merge couldn't route everything") is visible
    // per-node rather than only as an aggregate.
    const existing = extraIssuesByNode.get(ownerNode) ?? [];
    extraIssuesByNode.set(ownerNode, [
      ...existing,
      `${toFractionString(overflow)}/min of this node's part flow could not be routed across its sibling edges (all sibling capacities saturated)`,
    ]);
  }

  const nodeResults = nodeIds.map((id) =>
    buildNodeResult(
      id,
      profiles.get(id)!,
      counts.get(id)!,
      resolvedFlagByNode.get(id) ?? true,
      extraIssuesByNode.get(id) ?? [],
      forceInvalidByNode.has(id),
    ),
  );

  const outgoingGroupByOwnerPart = new Map<string, SplitGroup>();
  const incomingGroupByOwnerPart = new Map<string, SplitGroup>();
  for (const group of groups) {
    const key = groupOwnerKey(group.ownerNode, group.part);
    if (group.direction === "outgoing") outgoingGroupByOwnerPart.set(key, group);
    else incomingGroupByOwnerPart.set(key, group);
  }

  // Priority tiers aren't modeled by the joint resolver below (`jointFlow.ts`'s
  // own header explains why: two-tier bipartite fairness is a harder,
  // currently-unneeded problem) — any split/merge GROUP whose edges'
  // `inferredTier` (explicit `edge.priorityTier`, or auto-inferred from an
  // explicit `limit` on the other endpoint — see `inferredTier`'s own doc
  // comment) isn't uniform across all its siblings is a genuine two-tier
  // situation, and every edge in such a group, plus every edge in the same
  // connected component (per part) as one of them, keeps using this mode's
  // own tier-aware `finalAllocations` lookup, computed exactly as before.
  // Every OTHER component — the untiered majority, including the
  // byproduct-reuse topology this fix targets — gets resolved jointly
  // instead of each edge's two independent per-group shares being compared
  // in isolation (which is exactly what silently mis-split a shared
  // consumer's supply across two adjacent splitter/merger points — see this
  // fix's own investigation notes).
  const forcedTierEdgeIds = new Set<string>();
  for (const group of groups) {
    let hasTop = false;
    let hasBottom = false;
    for (const edge of group.edges) {
      const otherNode = group.direction === "outgoing" ? edge.toNode : edge.fromNode;
      if (inferredTier(edge, otherNode, profiles) === "top") hasTop = true;
      else hasBottom = true;
    }
    if (hasTop && hasBottom) {
      for (const edge of group.edges) forcedTierEdgeIds.add(edge.id);
    }
  }

  const tieredEdgeIds = new Set<string>();
  const edgesByPartForTierCheck = new Map<string, SolverEdge[]>();
  for (const edge of snapshot.edges) {
    const list = edgesByPartForTierCheck.get(edge.part) ?? [];
    list.push(edge);
    edgesByPartForTierCheck.set(edge.part, list);
  }
  for (const partEdges of edgesByPartForTierCheck.values()) {
    const flowEdges: JointFlowEdge[] = partEdges.map((e) => ({ id: e.id, from: sourceKey(e.fromNode), to: targetKey(e.toNode) }));
    for (const component of groupConnectedComponents(flowEdges)) {
      const hasForcedTier = component.some((fe) => forcedTierEdgeIds.has(fe.id));
      if (hasForcedTier) {
        for (const fe of component) tieredEdgeIds.add(fe.id);
      }
    }
  }

  const jointResolutions = resolveEdgesJointly(snapshot.edges, profiles, counts, {
    excludeEdgeIds: tieredEdgeIds,
    signal: options.signal,
  });

  const edgeIds = sortedIds(snapshot.edges.map((e) => e.id));
  const edgeById = new Map(snapshot.edges.map((e) => [e.id, e] as const));
  const edgeResults = edgeIds.map((id) => {
    const edge = edgeById.get(id)!;

    const joint = jointResolutions.get(id);
    if (joint) {
      return { edgeId: edge.id, part: edge.part, rate: toFractionString(joint.rate), valid: joint.valid, issues: joint.issues };
    }

    // Tiered component — the existing per-group, tier-aware computation.
    const sourceProfile = profiles.get(edge.fromNode);
    const targetProfile = profiles.get(edge.toNode);
    const issues: string[] = [];
    if (!sourceProfile?.recipe) issues.push(`source node "${edge.fromNode}" could not be resolved`);
    if (!targetProfile?.recipe) issues.push(`target node "${edge.toNode}" could not be resolved`);
    if (sourceProfile?.recipe && !sourceProfile.refRatePerPart.has(edge.part)) {
      issues.push(`source node "${edge.fromNode}"'s recipe has no part "${edge.part}"`);
    }
    if (targetProfile?.recipe && !targetProfile.refRatePerPart.has(edge.part)) {
      issues.push(`target node "${edge.toNode}"'s recipe has no part "${edge.part}"`);
    }

    if (issues.length > 0) {
      return { edgeId: edge.id, part: edge.part, rate: "0", valid: false, issues };
    }

    const outGroup = outgoingGroupByOwnerPart.get(groupOwnerKey(edge.fromNode, edge.part));
    const inGroup = incomingGroupByOwnerPart.get(groupOwnerKey(edge.toNode, edge.part));
    const sourceShare = (outGroup && finalAllocations.get(outGroup)?.get(edge.id)) ?? ZERO;
    const targetShare = (inGroup && finalAllocations.get(inGroup)?.get(edge.id)) ?? ZERO;
    const valid = equals(sourceShare, targetShare);
    const edgeIssues: string[] = [];
    if (!valid) {
      edgeIssues.push(
        `rate mismatch on part "${edge.part}": source side ${toFractionString(sourceShare)}/min, target side ${toFractionString(targetShare)}/min`,
      );
    }
    return { edgeId: edge.id, part: edge.part, rate: toFractionString(sourceShare), valid, issues: edgeIssues };
  });

  const summary = computeSummary(nodeIds, profiles, counts);
  const valid = nodeResults.every((n) => n.valid) && edgeResults.every((e) => e.valid);
  const warnings = [...extraIssuesByNode.values()].flat();

  return { mode: "full", nodes: nodeResults, edges: edgeResults, summary, valid, warnings };
}
