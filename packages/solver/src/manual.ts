// Manual mode: PLAN.md §2's table — "entered values are the final values
// you want" (spreadsheet-like). This mode never infers a machine count
// from the graph; every node's machine count comes purely from its own
// `limit`/`limitMode`/`clock` (`node.limit === null` defaults to exactly
// `ONE` machine, matching the "displayed default" convention Job 010's
// `recipeNodeMath.ts` already established for the no-solver stopgap). The
// only thing this mode's solve *computes* is validation: whether the
// entered values are self-consistent along every edge (PLAN.md §2: "same
// part, same rate in vs out at splits/merges") — see `edgeValidation.ts`.
import { ONE, toFractionString, type Rational } from "@scm/rational";
import type { GameData } from "@scm/gamedata";
import { buildEdgeGroups, validateEdge } from "./edgeValidation";
import { buildNodeProfile, pinnedMachineCount } from "./nodeProfile";
import { buildNodeResult } from "./nodeResult";
import { sortedIds } from "./ordering";
import type { SolveResult } from "./result";
import type { SolverSnapshot } from "./snapshot";
import { computeSummary } from "./summary";

export function solveManual(snapshot: SolverSnapshot, gameData: GameData): SolveResult {
  const nodeIds = sortedIds(snapshot.nodes.map((n) => n.id));
  const profiles = new Map(snapshot.nodes.map((n) => [n.id, buildNodeProfile(n, gameData)] as const));

  const counts = new Map<string, Rational>();
  const extraIssuesByNode = new Map<string, string[]>();
  const forceInvalidByNode = new Set<string>();

  for (const nodeId of nodeIds) {
    const profile = profiles.get(nodeId)!;
    if (!profile.recipe) {
      counts.set(nodeId, ONE);
      continue;
    }
    const pinned = pinnedMachineCount(profile);
    if (pinned.count) {
      counts.set(nodeId, pinned.count);
    } else if (pinned.issue) {
      counts.set(nodeId, ONE);
      extraIssuesByNode.set(nodeId, [pinned.issue]);
      forceInvalidByNode.add(nodeId);
    } else {
      // `node.limit === null`: Manual mode's documented default.
      counts.set(nodeId, ONE);
    }
  }

  const nodeResults = nodeIds.map((id) =>
    buildNodeResult(
      id,
      profiles.get(id)!,
      counts.get(id)!,
      true,
      extraIssuesByNode.get(id) ?? [],
      forceInvalidByNode.has(id),
    ),
  );

  const groups = buildEdgeGroups(snapshot.edges);
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

  return { mode: "manual", nodes: nodeResults, edges: edgeResults, summary, valid, warnings };
}
