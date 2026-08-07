// Job 019: pure, React/Yjs/DOM-free aggregation math for the summary panel
// (PLAN.md §3: "summary panel with made/used/unmade/unused, power made/
// used/net, sink points, and cost-to-build, scoped to Everything / Current
// Outpost / Selected"). Same "extract the pure logic so it's independently
// testable" discipline every prior canvas job has followed (Job 009's
// `filters.ts`, Job 010's `recipeNodeMath.ts`, Job 018's
// `apps/web/src/workers/mergeResults.ts`).
//
// ---------------------------------------------------------------------------
// WHY RE-DERIVE PER SCOPE INSTEAD OF SLICING `SolveSummary`
// ---------------------------------------------------------------------------
// `@scm/solver`'s own `SolveSummary` (`packages/solver/src/summary.ts`) is
// already-aggregated: `perPart.unmade`/`.unused` are each `max(0, ...)`
// over the WHOLE document's made/used totals. `max()` doesn't distribute
// over a subset the way a straight sum does (`mergeResults.ts`'s own
// "Summary merging" section documents the exact same trap at the
// worker-host layer, one level down) — you cannot recover "what would
// `unmade` have been for just these three nodes" from the document-wide
// `SolveSummary` alone. So every scope (including "Everything") re-derives
// made/used/unmade/unused/power/cost from the raw per-node
// `NodeSolveResult.partRates`/`.power`/`.machineCount` list, restricted to
// that scope's node ids — mirroring `packages/solver/src/summary.ts`'s own
// `computeSummary` and `apps/web/src/workers/mergeResults.ts`'s
// `summaryFromNodes` almost line for line, just over an arbitrary subset
// instead of "every node in one solve." `summaryMath.test.ts` cross-checks
// that running this over EVERY node reproduces `@scm/solver`'s own
// `SolveSummary` exactly, as a regression guard on that equivalence.
import {
  ZERO,
  abs,
  add,
  compare,
  isPositive,
  isZero,
  multiply,
  parseRational,
  subtract,
  toFractionString,
  type Rational,
} from "@scm/rational";
import type { GameData } from "@scm/gamedata";
import type { NodeSolveResult, PartBalance } from "@scm/solver";
import type { NodeRecord } from "@scm/ydoc";

export type SummaryScope = "everything" | "outpost" | "selected";

export interface ScopeInput {
  readonly scope: SummaryScope;
  /**
   * Every recipe node in the WHOLE document (not just the currently-viewed
   * container) — needed for "everything" and "outpost" (outposts are a
   * UI/rendering concept only, per Job 013's design; a node's `containerId`
   * doesn't change what's in the solver graph, only what's currently
   * rendered — see `apps/web/src/workers/buildSnapshot.ts`'s header for the
   * same principle one layer down). Unused for "selected".
   */
  readonly allNodes: readonly Pick<NodeRecord, "id" | "containerId">[];
  /**
   * The container currently being viewed — PLAN.md §2's "Current Outpost"
   * scope. Direct children of this container only, not recursive — PLAN.md
   * §2's fuller scope-operation list has a separate "Current Outpost &
   * Below" for the recursive variant, which this job leaves out per its own
   * Out-of-scope note (see jobs/019's Handoff notes for the explicit gap).
   */
  readonly currentContainerId: string;
  /** Node ids the user currently has selected (Job 012's `.selected` flags). Unused for "everything"/"outpost". */
  readonly selectedNodeIds: ReadonlySet<string>;
}

/** Which node ids belong to `input.scope` — see `ScopeInput`'s own field comments for each case's exact rule. */
export function nodeIdsForScope(input: ScopeInput): ReadonlySet<string> {
  switch (input.scope) {
    case "everything":
      return new Set(input.allNodes.map((n) => n.id));
    case "outpost":
      return new Set(
        input.allNodes.filter((n) => n.containerId === input.currentContainerId).map((n) => n.id),
      );
    case "selected":
      return new Set(input.selectedNodeIds);
  }
}

export interface CostEntryTotal {
  readonly part: string;
  /** Canonical `n/d` string — `sum(machineCount x Machine.Cost.amount)` over every node in scope that resolved to a real machine. */
  readonly amount: string;
}

export interface ScopedSummary {
  readonly perPart: Readonly<Record<string, PartBalance>>;
  readonly powerMade: number;
  readonly powerUsed: number;
  readonly powerNet: number;
  /**
   * Always `"0"` — no AWESOME Sink node kind exists in the document schema
   * yet (see `@scm/solver`'s own `SolveSummary.sinkPoints` doc comment,
   * Job 017's documented limitation). Carried through unchanged rather than
   * "fixed" here — there is nothing yet to sum.
   */
  readonly sinkPoints: string;
  /** Cost-to-build, sorted by part name. Empty when no node in scope resolved to a real machine (e.g. an empty selection). */
  readonly cost: readonly CostEntryTotal[];
  /** `nodeIds.size` — how many nodes this scope covers, regardless of whether they were actually in the last solve. */
  readonly nodeCount: number;
  /** How many of those nodes actually had a `NodeSolveResult` (i.e. were part of the most recent solve) — lets a caller show "N of M solved" instead of silently under-counting a stale/partial result. */
  readonly solvedNodeCount: number;
}

/**
 * Recomputes made/used/unmade/unused/power/cost purely from `nodeResults`
 * restricted to `nodeIds`, resolving each node's own build cost via
 * `nodeRecordById`'s `machine` field against `gameData.machinesByName`.
 * Safe to call with `nodeIds` covering every node in the document (the
 * "Everything" scope) — `summaryMath.test.ts` verifies doing so reproduces
 * `@scm/solver`'s own whole-graph `SolveSummary.perPart`/power fields
 * exactly.
 */
export function summarizeScope(
  nodeIds: ReadonlySet<string>,
  nodeResults: readonly NodeSolveResult[],
  nodeRecordById: ReadonlyMap<string, Pick<NodeRecord, "machine">>,
  gameData: GameData,
): ScopedSummary {
  const made = new Map<string, Rational>();
  const used = new Map<string, Rational>();
  const cost = new Map<string, Rational>();
  let powerMade = 0;
  let powerUsed = 0;
  let solvedNodeCount = 0;

  for (const nodeResult of nodeResults) {
    if (!nodeIds.has(nodeResult.nodeId)) continue;
    solvedNodeCount += 1;

    for (const [part, rateStr] of Object.entries(nodeResult.partRates)) {
      const rate = parseRational(rateStr);
      if (isZero(rate)) continue;
      if (isPositive(rate)) {
        made.set(part, add(made.get(part) ?? ZERO, rate));
      } else {
        used.set(part, add(used.get(part) ?? ZERO, abs(rate)));
      }
    }

    if (nodeResult.power > 0) powerMade += nodeResult.power;
    else powerUsed += -nodeResult.power;

    const record = nodeRecordById.get(nodeResult.nodeId);
    const machine = record?.machine ? gameData.machinesByName.get(record.machine) : undefined;
    if (machine && machine.cost.length > 0) {
      const count = parseRational(nodeResult.machineCount);
      for (const entry of machine.cost) {
        cost.set(entry.part, add(cost.get(entry.part) ?? ZERO, multiply(entry.amount, count)));
      }
    }
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

  const costEntries: CostEntryTotal[] = [...cost.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([part, amount]) => ({ part, amount: toFractionString(amount) }));

  return {
    perPart,
    powerMade,
    powerUsed,
    powerNet: powerMade - powerUsed,
    sinkPoints: "0",
    cost: costEntries,
    nodeCount: nodeIds.size,
    solvedNodeCount,
  };
}
