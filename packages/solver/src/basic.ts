// Basic mode: PLAN.md §2's table — "entered values are limits", solved
// with "No" splitter/merger preference modeling. This is the mode PLAN.md
// §5 point 4 singles out by name: "the Basic calculator 'may produce
// inconsistent results when multiple valid solutions exist,' so we must
// pin a fixed variable ordering and a deterministic pivot rule, or
// collaborators will see different numbers for identical state."
//
// ---------------------------------------------------------------------------
// THE ALGORITHM (read this before touching anything below)
// ---------------------------------------------------------------------------
//
// This is deliberately NOT a general flow solver/LP (that's Full mode,
// Job 023's job — see PLAN.md §6). It resolves the common case (chains and
// trees rooted at explicitly-limited nodes) exactly and deterministically,
// and falls back to a documented default for anything a single relaxation
// pass can't reach.
//
// 1. PIN: every node with `limit !== null` gets an immediate machine count
//    from `nodeProfile.ts`'s `pinnedMachineCount` — no graph involved.
//
// 1b. SOFT PIN (this module's `solveBasic`, between PIN and PROPAGATE): a
//    blank-ppm resource-extraction node (Miner/Water Extractor/Oil
//    Extractor/Resource Well Extractor — `pinnedMachineCount` never pins
//    these; see that function's own doc comment) gets ONE chance to resolve
//    from real, explicitly-limited neighbors via a first PROPAGATE pass
//    seeded from hard pins only. Any such node PROPAGATE still couldn't
//    reach then gets `nodeProfile.ts`'s `resourceExtractorSoftDefault` (a
//    flat 60ppm target) folded into the pin set for a second PROPAGATE pass.
//    This is what lets a blank Miner wired to an explicitly-limited Smelter
//    derive its rate from that demand, while a blank Miner with nothing
//    downstream to derive from still lands on a sensible, non-mismatching
//    default instead of the bare `ONE`-machine fallback two independently
//    unpinned nodes would otherwise each hit on their own (see
//    `golden.test.ts`'s "freshly-placed, never-touched Miner" regression
//    test for exactly the scenario this prevents). A resource-extraction
//    node can never itself be downstream of another unresolved one of these
//    (they have no input parts — always graph sources), so seeding every
//    still-unresolved one's soft default in the SAME second pass can never
//    race or conflict between two of them.
//
// 2. PROPAGATE (this module's `propagateMachineCounts`): repeatedly scan
//    every still-unresolved node (in a pass) and ask "does any edge connect
//    me to an already-resolved node, for a part my recipe actually has?"
//    If yes, the unresolved node's rate for that part is the SUM of the
//    "implied shares" over every such edge, where an implied share is the
//    resolved neighbor's OWN total rate for that part, divided evenly
//    across however many sibling edges the neighbor has for that same
//    part (the even-split rule — see `edgeGroups.ts`). Once a total rate
//    for one part is known, the node's machine count follows directly
//    (`machineCountForTargetRate`; every other part scales with the same
//    machine count, so one resolved part is enough).
//
//    This repeats pass-over-pass until a full pass resolves nothing new
//    (a fixed point) — the node/edge graph can be almost any shape, but
//    each pass can only extend the "resolved" frontier outward by one hop,
//    so this always terminates in at most `nodes.length` passes.
//
// 3. FALLBACK: anything still unresolved after the fixed point (an
//    isolated node, or a whole connected component with no pinned node at
//    all — the graph genuinely doesn't determine it) defaults to exactly
//    `ONE` machine, flagged `resolved: false` in the result so a caller
//    can grey it out rather than presenting it as authoritative.
//
// DETERMINISM, precisely:
//   - Even-split division is EXACT `Rational` arithmetic — dividing a rate
//     by an integer sibling count never has a remainder to break a tie
//     over, so there is no ordering dependence in the arithmetic itself.
//   - When several edges resolve the same node in the same pass, the
//     PIVOT RULE is: sum every implied share for a given part (this is
//     what "no priority — no even-split *preference*" means operationally:
//     every resolved neighbor's contribution counts equally, combined by
//     plain addition, which is commutative — order genuinely cannot
//     matter). Among *different* parts with implied rates, the pivot picks
//     the recipe's own `primaryPart` if it has one, else the
//     alphabetically-first part name — both are properties of the data,
//     not of iteration order.
//   - Passes are Jacobi-style, not Gauss-Seidel: every pass computes its
//     candidate updates from the PREVIOUS pass's frozen `resolved` set and
//     commits them all at once at the end of the pass. A node's scan
//     order within a pass therefore cannot affect what it sees.
//   - Every node/edge id list this module touches is sorted via
//     `ordering.ts`'s `idCompare` before use, so even the bookkeeping
//     (which order results are assembled in) is independent of the
//     snapshot's own array order. See `determinism.test.ts` for the test
//     that exercises exactly this: the same logical graph, submitted with
//     shuffled node/edge array order, produces identical output.
import { ONE, ZERO, add, compare, isNegative, isZero, negate, isPositive, type Rational } from "@scm/rational";
import type { GameData } from "@scm/gamedata";
import { buildEdgeGroups, edgeShareFromSource, edgeShareFromTarget } from "./edgeGroups";
import { resolveEdgesJointly } from "./edgeResolution";
import {
  buildNodeProfile,
  machineCountForTargetRate,
  pinnedMachineCount,
  resourceExtractorSoftDefault,
  type NodeProfile,
} from "./nodeProfile";
import { buildNodeResult } from "./nodeResult";
import { idCompare, sortedIds } from "./ordering";
import type { SolveResult } from "./result";
import type { SolverEdge, SolverSnapshot } from "./snapshot";
import { computeSummary } from "./summary";
import { toFractionString } from "@scm/rational";

interface IncidentEdge {
  readonly edge: SolverEdge;
  readonly otherNode: string;
  readonly part: string;
  /** `true` if the node we're building this list FOR is `edge.fromNode` (a producer of `part` on this edge). */
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
  for (const list of incidentByNode.values()) {
    list.sort((a, b) => idCompare(a.edge.id, b.edge.id));
  }
  return incidentByNode;
}

export interface PropagationResult {
  readonly counts: Map<string, Rational>;
  readonly resolved: Set<string>;
}

/**
 * The fixed-point relaxation described in this module's header comment.
 * `nodeIds` must already be sorted (callers pass the same sorted list they
 * use everywhere else). `pinned` is the starting "resolved" set.
 */
export function propagateMachineCounts(
  nodeIds: readonly string[],
  profiles: ReadonlyMap<string, NodeProfile>,
  edges: readonly SolverEdge[],
  pinned: ReadonlyMap<string, Rational>,
): PropagationResult {
  const groups = buildEdgeGroups(edges);
  const incidentByNode = buildIncidence(edges);
  const counts = new Map(pinned);
  const resolved = new Set(pinned.keys());

  let progress = true;
  while (progress) {
    progress = false;
    const updates = new Map<string, Rational>();

    for (const nodeId of nodeIds) {
      if (resolved.has(nodeId)) continue;
      const profile = profiles.get(nodeId);
      if (!profile?.recipe) continue;

      // `capMachineCountAtNodeId` (see `snapshot.ts`'s own doc comment) —
      // a Storage Container's outflow side can never supply more than its
      // intake side is actually receiving, no matter how much downstream
      // demands. Withholding entirely until the cap node itself resolves
      // (rather than letting this node resolve off downstream demand THEN
      // trying to retroactively cap it) matters because `resolved` is
      // permanent once set within this fixed point — a node resolved off
      // an uncapped downstream pin in an earlier pass could never be
      // revisited once the cap becomes known in a later one. Deferring
      // guarantees the cap is always known before this node ever commits,
      // at the cost of one extra pass whenever both sides hard-pin in the
      // very same pass (Jacobi semantics: a node resolved in pass N isn't
      // visible to another node's SAME pass N, only pass N+1 onward).
      const capNodeId = profile.node.capMachineCountAtNodeId;
      if (capNodeId && !resolved.has(capNodeId)) continue;
      const capCount = capNodeId ? counts.get(capNodeId) : undefined;

      // Known limitation: keyed by bare part name, so an UNPINNED node that
      // has incident edges on BOTH sides of a part name a recipe lists
      // twice (an input entry and a separate byproduct output entry — e.g.
      // Encased Uranium Cell's Sulfuric Acid) would have those two
      // physically-different implied rates summed together here as if they
      // were about the same port. Each individual `edgeShareFromSource`/
      // `edgeShareFromTarget` call above is itself correct (they now pass
      // the right direction — see `edgeGroups.ts`); it's only this
      // aggregation step, and `chosenPart`/`partEntry` below picking
      // whichever entry `.find` happens to match first, that stays
      // ambiguous. Doesn't affect Generate Factory's output (every
      // generated node is pinned, so it never reaches propagation at all —
      // see `applyFactoryPlan.ts`), only a hand-built, unpinned Basic-mode
      // node using one of these rare recipes on both sides at once.
      const impliedByPart = new Map<string, Rational>();
      for (const incident of incidentByNode.get(nodeId) ?? []) {
        if (!resolved.has(incident.otherNode)) continue;
        const otherProfile = profiles.get(incident.otherNode);
        const otherCount = counts.get(incident.otherNode);
        if (!otherProfile?.recipe || otherCount === undefined) continue;

        const share = incident.asSource
          ? edgeShareFromTarget(incident.edge, otherProfile, otherCount, groups)
          : edgeShareFromSource(incident.edge, otherProfile, otherCount, groups);
        impliedByPart.set(incident.part, add(impliedByPart.get(incident.part) ?? ZERO, share));
      }
      if (impliedByPart.size === 0) {
        // No real (downstream-demand) neighbor could seed this node this
        // pass — if it has a cap, that cap alone is its resolved supply
        // (the "nothing downstream happens to be pinned" case: a Storage
        // Container just passes through exactly what it's receiving).
        if (capCount !== undefined) updates.set(nodeId, capCount);
        continue;
      }

      // Deterministic pivot: the recipe's own primary part if it has an
      // implied rate, else the alphabetically-first part name that does.
      // `candidateParts[0]` is safe unguarded: `impliedByPart.size === 0`
      // already returned above, so the sorted key list is never empty.
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
        // Downstream wants `count` — but never more than the cap allows.
        // Below the cap (or no cap at all), downstream's own number stands
        // untouched; ABOVE it, this node commits to the cap instead, which
        // leaves the demanding downstream neighbor's own edge looking
        // under-supplied — the exact same rate-mismatch/shortage machinery
        // (`edgeValidation.ts`/`computeInputShortage.ts`) that already
        // flags any two ordinary mismatched pinned nodes, no special-casing
        // needed for this node kind.
        updates.set(nodeId, capCount !== undefined && compare(capCount, count) < 0 ? capCount : count);
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

export function solveBasic(snapshot: SolverSnapshot, gameData: GameData): SolveResult {
  const nodeIds = sortedIds(snapshot.nodes.map((n) => n.id));
  const profiles = new Map(snapshot.nodes.map((n) => [n.id, buildNodeProfile(n, gameData)] as const));

  const hardPinned = new Map<string, Rational>();
  const extraIssuesByNode = new Map<string, string[]>();
  const forceInvalidByNode = new Set<string>();

  for (const nodeId of nodeIds) {
    const profile = profiles.get(nodeId)!;
    if (!profile.recipe) continue;
    const result = pinnedMachineCount(profile);
    if (result.count) {
      hardPinned.set(nodeId, result.count);
    } else if (result.issue) {
      extraIssuesByNode.set(nodeId, [result.issue]);
      forceInvalidByNode.add(nodeId);
    }
  }

  // First pass: propagate from real, explicit pins only, so a blank
  // resource-extraction node's soft default (below) never shadows an actual
  // graph-derivable rate.
  const afterHardPins = propagateMachineCounts(nodeIds, profiles, snapshot.edges, hardPinned);

  // Second pass: fold in a flat 60ppm soft pin for every resource-extraction
  // node the first pass still couldn't reach, then propagate once more —
  // see this module's header comment (step 1b) for why one more pass always
  // suffices.
  const softPinned = new Map(hardPinned);
  for (const nodeId of nodeIds) {
    if (afterHardPins.resolved.has(nodeId)) continue;
    const soft = resourceExtractorSoftDefault(profiles.get(nodeId)!);
    if (soft) softPinned.set(nodeId, soft);
  }
  const { counts, resolved } =
    softPinned.size === hardPinned.size
      ? afterHardPins
      : propagateMachineCounts(nodeIds, profiles, snapshot.edges, softPinned);

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
      extraIssuesByNode.set(nodeId, [
        ...existing,
        "no limit and no resolvable neighbor — defaulted to 1 machine",
      ]);
    }
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

  // Joint, not per-edge independent (`edgeShareFromSource`/`Target` alone):
  // see `edgeResolution.ts`/`jointFlow.ts`'s headers for why two splitter/
  // merger points adjacent on the same part (e.g. byproduct reuse feeding
  // the same consumers a raw producer already does) need every connected
  // edge solved together, not each edge's two endpoints compared in
  // isolation.
  const edgeIds = sortedIds(snapshot.edges.map((e) => e.id));
  const edgeById = new Map(snapshot.edges.map((e) => [e.id, e] as const));
  const edgeResolutions = resolveEdgesJointly(snapshot.edges, profiles, counts);
  const edgeResults = edgeIds.map((id) => {
    const edge = edgeById.get(id)!;
    const internal = edgeResolutions.get(id)!;
    return {
      edgeId: edge.id,
      part: edge.part,
      rate: toFractionString(internal.rate),
      valid: internal.valid,
      issues: internal.issues,
    };
  });

  const summary = computeSummary(nodeIds, profiles, counts);
  const valid = nodeResults.every((n) => n.valid) && edgeResults.every((e) => e.valid);
  const warnings = [...extraIssuesByNode.values()].flat();

  return { mode: "basic", nodes: nodeResults, edges: edgeResults, summary, valid, warnings };
}
