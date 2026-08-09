// Joint replacement for `edgeValidation.ts`'s per-edge `validateEdge` (Basic
// mode) and `full.ts`'s per-edge `finalAllocations` lookup (Full mode's
// finalize step) — see `jointFlow.ts`'s header for WHY a per-edge
// computation isn't enough once two splitter/merger points sit adjacent on
// the same part (the byproduct-reuse topology). This module is the seam
// between that pure algorithm and the solver's actual `SolverEdge`/
// `NodeProfile` shapes: it resolves the same "source/target couldn't be
// resolved" pre-checks `validateEdge` always has, partitions the rest into
// connected components per part, and reports a single reconciled
// rate/validity per edge — no more "source side X, target side Y" split
// verdict, since the joint algorithm can't disagree with itself.
import { abs, toFractionString, ZERO, type Rational } from "@scm/rational";
import type { NodeProfile } from "./nodeProfile";
import { partRateAtMachineCount } from "./nodeProfile";
import { idCompare } from "./ordering";
import type { SolverEdge } from "./snapshot";
import { groupConnectedComponents, jointMaxMinFairFlow, type JointFlowEdge } from "./jointFlow";
import type { CancellationSignal } from "./waterFill";

export interface EdgeResolution {
  readonly rate: Rational;
  readonly valid: boolean;
  readonly issues: readonly string[];
}

/**
 * Disjoint vertex-key namespaces so a node that's simultaneously a source
 * and a target for the same part (a recipe listing that part twice — see
 * `nodeProfile.ts`'s `refRatePerPartByDirection`) gets two distinct
 * joint-flow vertices, not one conflated total. Exported so `full.ts` can
 * build the SAME vertex identities for its own "does this component
 * contain a priority-tiered edge" pre-check (`jointFlow.ts` doesn't model
 * tiers — see that module's header).
 */
export function sourceKey(nodeId: string): string {
  return `src:${nodeId}`;
}
export function targetKey(nodeId: string): string {
  return `tgt:${nodeId}`;
}

/**
 * The same "source/target node or part couldn't be resolved" pre-checks
 * `validateEdge`/`full.ts`'s inline edge loop both already perform —
 * factored out so `resolveEdgesJointly` can run them once, uniformly,
 * before anything is grouped into a joint component (an edge that fails
 * this never participates in one — there's nothing coherent to solve
 * jointly with an unresolved endpoint).
 */
function checkEndpoints(
  edge: SolverEdge,
  profiles: ReadonlyMap<string, NodeProfile>,
  counts: ReadonlyMap<string, Rational>,
): readonly string[] {
  const issues: string[] = [];
  const sourceProfile = profiles.get(edge.fromNode);
  const targetProfile = profiles.get(edge.toNode);
  if (!sourceProfile?.recipe || counts.get(edge.fromNode) === undefined) {
    issues.push(`source node "${edge.fromNode}" could not be resolved`);
  }
  if (!targetProfile?.recipe || counts.get(edge.toNode) === undefined) {
    issues.push(`target node "${edge.toNode}" could not be resolved`);
  }
  if (issues.length > 0) return issues;
  if (!sourceProfile!.refRatePerPart.has(edge.part)) {
    issues.push(`source node "${edge.fromNode}"'s recipe has no part "${edge.part}"`);
  }
  if (!targetProfile!.refRatePerPart.has(edge.part)) {
    issues.push(`target node "${edge.toNode}"'s recipe has no part "${edge.part}"`);
  }
  return issues;
}

/**
 * Resolves every edge in `edges` (except any listed in `excludeEdgeIds` —
 * Full mode's own escape hatch for a priority-tiered component; see
 * `full.ts`'s call site) into a single reconciled rate/validity, jointly
 * across every part's own connected components (`jointFlow.ts`). An edge
 * whose endpoints fail the basic resolution pre-check gets the same
 * individually-invalid result `validateEdge` always gave it, and never
 * enters a joint component (nothing to jointly solve with an unresolved
 * neighbor).
 *
 * Returns a result for every edge in `edges` NOT in `excludeEdgeIds` —
 * callers are responsible for the excluded ones themselves.
 */
export function resolveEdgesJointly(
  edges: readonly SolverEdge[],
  profiles: ReadonlyMap<string, NodeProfile>,
  counts: ReadonlyMap<string, Rational>,
  options: { readonly excludeEdgeIds?: ReadonlySet<string>; readonly signal?: CancellationSignal } = {},
): Map<string, EdgeResolution> {
  const results = new Map<string, EdgeResolution>();
  const excluded = options.excludeEdgeIds ?? new Set<string>();

  const byPart = new Map<string, SolverEdge[]>();
  for (const edge of edges) {
    if (excluded.has(edge.id)) continue;
    const preCheckIssues = checkEndpoints(edge, profiles, counts);
    if (preCheckIssues.length > 0) {
      results.set(edge.id, { rate: ZERO, valid: false, issues: preCheckIssues });
      continue;
    }
    const list = byPart.get(edge.part) ?? [];
    list.push(edge);
    byPart.set(edge.part, list);
  }

  for (const part of [...byPart.keys()].sort(idCompare)) {
    const partEdges = byPart.get(part)!;
    const flowEdges: JointFlowEdge[] = partEdges.map((e) => ({
      id: e.id,
      from: sourceKey(e.fromNode),
      to: targetKey(e.toNode),
    }));

    for (const component of groupConnectedComponents(flowEdges)) {
      const totals = new Map<string, Rational>();
      const sourceNodeIds = new Set<string>();
      const targetNodeIds = new Set<string>();
      for (const flowEdge of component) {
        const original = partEdges.find((e) => e.id === flowEdge.id)!;
        if (!totals.has(flowEdge.from)) {
          sourceNodeIds.add(original.fromNode);
          totals.set(
            flowEdge.from,
            abs(partRateAtMachineCount(profiles.get(original.fromNode)!, part, counts.get(original.fromNode)!, "output")),
          );
        }
        if (!totals.has(flowEdge.to)) {
          targetNodeIds.add(original.toNode);
          totals.set(
            flowEdge.to,
            abs(partRateAtMachineCount(profiles.get(original.toNode)!, part, counts.get(original.toNode)!, "input")),
          );
        }
      }

      const { rate, shortfall } = jointMaxMinFairFlow(totals, component, options.signal);

      for (const flowEdge of component) {
        const sourceShort = shortfall.get(flowEdge.from);
        const targetShort = shortfall.get(flowEdge.to);
        results.set(flowEdge.id, {
          rate: rate.get(flowEdge.id)!,
          valid: !sourceShort && !targetShort,
          issues: describeShortfall(part, sourceShort, targetShort, sourceNodeIds.size, targetNodeIds.size),
        });
      }
    }
  }

  return results;
}

function describeShortfall(
  part: string,
  sourceShort: Rational | undefined,
  targetShort: Rational | undefined,
  producerCount: number,
  consumerCount: number,
): readonly string[] {
  if (!sourceShort && !targetShort) return [];
  const issues: string[] = [];
  if (targetShort) {
    issues.push(
      `rate mismatch on part "${part}": ${producerCount} connected producer(s) fall ${toFractionString(targetShort)}/min short of ${consumerCount} connected consumer(s)' combined demand`,
    );
  }
  if (sourceShort) {
    issues.push(
      `rate mismatch on part "${part}": ${producerCount} connected producer(s) supply ${toFractionString(sourceShort)}/min more than ${consumerCount} connected consumer(s) can use`,
    );
  }
  return issues;
}
