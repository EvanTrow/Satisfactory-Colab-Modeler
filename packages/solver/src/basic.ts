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
import { ONE, ZERO, add, isNegative, isZero, negate, isPositive, type Rational } from "@scm/rational";
import type { GameData } from "@scm/gamedata";
import { buildEdgeGroups, edgeShareFromSource, edgeShareFromTarget, type EdgeGroups } from "./edgeGroups";
import { validateEdge } from "./edgeValidation";
import {
  buildNodeProfile,
  machineCountForTargetRate,
  pinnedMachineCount,
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
      if (impliedByPart.size === 0) continue;

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

export function solveBasic(snapshot: SolverSnapshot, gameData: GameData): SolveResult {
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

  const { counts, resolved } = propagateMachineCounts(nodeIds, profiles, snapshot.edges, pinned);

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

  const groups: EdgeGroups = buildEdgeGroups(snapshot.edges);
  const edgeIds = sortedIds(snapshot.edges.map((e) => e.id));
  const edgeById = new Map(snapshot.edges.map((e) => [e.id, e] as const));
  const edgeResults = edgeIds.map((id) => {
    const edge = edgeById.get(id)!;
    const internal = validateEdge(edge, profiles, counts, groups);
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
