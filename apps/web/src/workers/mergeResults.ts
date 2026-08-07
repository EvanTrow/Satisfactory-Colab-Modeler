// Merges the per-component results a debounce tick collected (a mix of
// cache hits and freshly-solved components, see `solveScheduler.ts`) back
// into one document-wide `SolveResult` — the shape Job 019 actually
// consumes. Also the inverse: slicing one worker round trip's combined
// result (several dirty components solved together in a single `solve()`
// call, for fewer worker messages) back into one cache entry per component.
import { ZERO, abs, add, compare, isPositive, isZero, parseRational, subtract, toFractionString, type Rational } from "@scm/rational";
import type {
  EdgeSolveResult,
  NodeSolveResult,
  PartBalance,
  SolveResult,
  SolveSummary,
  SolverMode,
} from "@scm/solver";

import { idCompare } from "./ordering";
import type { SolverComponent } from "./partition";

export interface ComponentResult {
  readonly nodes: readonly NodeSolveResult[];
  readonly edges: readonly EdgeSolveResult[];
}

/**
 * The canonical trivial result for `mode: "none"` (or an empty graph) —
 * literally identical in shape to `@scm/solver`'s own `solveNone()`
 * (`packages/solver/src/none.ts`). Kept as a small local literal instead of
 * importing and calling the real `solve()` here, so the MAIN thread never
 * needs `@scm/solver`'s runtime (and, transitively, `@scm/gamedata`'s
 * ~136KB `game_data.json`) in its own bundle — only the Worker does. The
 * main thread only ever imports `@scm/solver`'s *types* (erased at compile
 * time, zero runtime cost) — see this directory's `protocol.ts`.
 */
export function noneResult(): SolveResult {
  return {
    mode: "none",
    nodes: [],
    edges: [],
    summary: { perPart: {}, powerMade: 0, powerUsed: 0, powerNet: 0, sinkPoints: "0" },
    valid: true,
    warnings: [],
  };
}

/**
 * Slices one combined worker round trip's `SolveResult` (which may cover
 * more than one dirty `SolverComponent` at once — see `solveScheduler.ts`'s
 * `dispatchSolve`) back into one `ComponentResult` per component it
 * covered, by node/edge id membership. This is what makes it correct to
 * cache each component independently afterward even though they were
 * solved together in a single `solve()` call: components are, by
 * definition, not connected by any edge, so solving them together produces
 * byte-identical per-node/per-edge results to solving each alone (Basic
 * mode's propagation only ever looks across an edge — see
 * `packages/solver/src/basic.ts` — and there are none between components).
 */
export function splitResultByComponents(
  result: SolveResult,
  components: readonly SolverComponent[],
): ComponentResult[] {
  const nodeById = new Map(result.nodes.map((n) => [n.nodeId, n] as const));
  const edgeById = new Map(result.edges.map((e) => [e.edgeId, e] as const));
  return components.map((component) => ({
    nodes: component.snapshot.nodes
      .map((n) => nodeById.get(n.id))
      .filter((n): n is NodeSolveResult => n !== undefined),
    edges: component.snapshot.edges
      .map((e) => edgeById.get(e.id))
      .filter((e): e is EdgeSolveResult => e !== undefined),
  }));
}

/**
 * `SolveSummary` is, by `@scm/solver`'s own design (see
 * `packages/solver/src/result.ts`'s `PartBalance` doc comment), "a pure
 * production/consumption balance across every node in the snapshot — not a
 * flow-through-edges computation." That means it's entirely derivable from
 * the public `NodeSolveResult.partRates`/`.power` fields alone, with no
 * need for `@scm/solver`'s internal `NodeProfile`/machine-count types —
 * this function reimplements exactly `packages/solver/src/summary.ts`'s
 * `computeSummary` formula, but over the public per-node RESULT shape
 * instead of the internal per-node PROFILE/count shape, so it can run on
 * any merged subset of nodes (a single component, several components
 * merged, or the whole document) and produce the same answer a single
 * global `solve()` call's own `.summary` would have. `mergeResults.test.ts`
 * asserts this equivalence directly against a real `solve()` call.
 */
function summaryFromNodes(nodes: readonly NodeSolveResult[]): SolveSummary {
  const made = new Map<string, Rational>();
  const used = new Map<string, Rational>();
  let powerMade = 0;
  let powerUsed = 0;

  for (const node of nodes) {
    for (const [part, rateString] of Object.entries(node.partRates)) {
      const rate = parseRational(rateString);
      if (isZero(rate)) continue;
      if (isPositive(rate)) {
        made.set(part, add(made.get(part) ?? ZERO, rate));
      } else {
        used.set(part, add(used.get(part) ?? ZERO, abs(rate)));
      }
    }
    if (node.power > 0) powerMade += node.power;
    else powerUsed += -node.power;
  }

  const partNames = [...new Set([...made.keys(), ...used.keys()])].sort();
  const perPart: Record<string, PartBalance> = {};
  for (const part of partNames) {
    const madeAmount = made.get(part) ?? ZERO;
    const usedAmount = used.get(part) ?? ZERO;
    const unmade = compare(usedAmount, madeAmount) > 0 ? subtract(usedAmount, madeAmount) : ZERO;
    const unused = compare(madeAmount, usedAmount) > 0 ? subtract(madeAmount, usedAmount) : ZERO;
    perPart[part] = {
      made: toFractionString(madeAmount),
      used: toFractionString(usedAmount),
      unmade: toFractionString(unmade),
      unused: toFractionString(unused),
    };
  }

  return {
    perPart,
    powerMade,
    powerUsed,
    powerNet: powerMade - powerUsed,
    // AWESOME Sink has no snapshot representation yet — matches
    // `@scm/solver`'s own hardcoded "0" (see `result.ts`'s header).
    sinkPoints: "0",
  };
}

/**
 * Merges a set of `ComponentResult`s (a mix of cache hits and freshly
 * solved components) into one document-wide `SolveResult`. `valid`/
 * `warnings` are recomputed from the merged node/edge lists rather than
 * concatenated from each component's own (now-discarded) `SolveResult.
 * valid`/`.warnings` fields:
 *   - `valid` is recomputed as `nodes.every(valid) && edges.every(valid)` —
 *     BYTE-IDENTICAL to how `basic.ts`/`manual.ts` compute it themselves
 *     (see those modules), so this is not a behavioral change, just the
 *     same formula run over the merged list instead of one snapshot's own.
 *   - `warnings` is recomputed as the flattened `issues` of every merged
 *     node/edge, which is a deliberate, documented IMPROVEMENT over
 *     `@scm/solver`'s own top-level `warnings` field (that field is
 *     actually a narrower subset — see `basic.ts`/`manual.ts`'s
 *     `extraIssuesByNode`, which omits `NodeProfile`-level issues like
 *     "unknown recipe" — flagged in this job's Handoff notes as a place
 *     Job 019 should prefer this merged result's `warnings` over anything
 *     it might otherwise expect from `@scm/solver` directly).
 */
export function mergeComponentResults(mode: SolverMode, components: readonly ComponentResult[]): SolveResult {
  const nodes = components
    .flatMap((c) => c.nodes)
    .slice()
    .sort((a, b) => idCompare(a.nodeId, b.nodeId));
  const edges = components
    .flatMap((c) => c.edges)
    .slice()
    .sort((a, b) => idCompare(a.edgeId, b.edgeId));

  const valid = nodes.every((n) => n.valid) && edges.every((e) => e.valid);
  const warnings = [...nodes.flatMap((n) => n.issues), ...edges.flatMap((e) => e.issues)];

  return { mode, nodes, edges, summary: summaryFromNodes(nodes), valid, warnings };
}
