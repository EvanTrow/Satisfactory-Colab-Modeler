// The plain-data output boundary — see `snapshot.ts`'s header for the same
// "no Yjs, no DOM" boundary this type also has to respect. Every numeric
// field that isn't power is a canonical `@scm/rational` `n/d` string
// (round-trippable via `parseRational`), never a `number` — see PLAN.md §1's
// exactness-boundary note. `power` fields are the one deliberate exception
// (`@scm/rational`'s `powerAtClock` float boundary).
//
// Deliberately "enough for Job 019 to render without needing solver
// internals" (this job's own Deliverables wording): per-node computed
// values, per-edge rates, validity flags, and summary aggregates. Job 019
// should not need to import anything from this package except these types
// plus `solve()` itself.

import type { SolverMode } from "./snapshot";

export interface NodeSolveResult {
  readonly nodeId: string;
  /** Canonical `n/d` string. Always `"1"` for None mode (no computation performed). */
  readonly machineCount: string;
  /** Canonical `n/d` string, percentage (e.g. `"100"`). */
  readonly clockPercent: string;
  /**
   * `true` when this node's machine count came from an explicit limit (or,
   * in Basic mode, was successfully inferred from a connected neighbor).
   * `false` only in Basic mode, when the node had no limit and no
   * resolvable neighbor, so it fell back to the documented 1-machine
   * default — see `basic.ts`. Always `true` for None/Manual (neither mode
   * has an "unresolved" concept: None computes nothing, Manual never
   * infers).
   */
  readonly resolved: boolean;
  /** `@scm/gamedata` part name -> signed per-minute rate (canonical `n/d` string). Empty for None mode. */
  readonly partRates: Readonly<Record<string, string>>;
  /** MW, signed (positive = generates, negative = consumes). The float boundary — see `nodeProfile.ts`'s `nodePower`. `0` for None mode. */
  readonly power: number;
  /** `false` if the node's recipe/machine/shard count couldn't be resolved, or an entered limit was malformed. */
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface EdgeSolveResult {
  readonly edgeId: string;
  readonly part: string;
  /**
   * Canonical `n/d` string, always non-negative: the per-minute magnitude
   * flowing `fromNode` -> `toNode` along this one connection (already
   * divided evenly across sibling edges of the same node+part — "no
   * splitter/merger preference modeling" per PLAN.md §2's table). `"0"` for
   * None mode.
   */
  readonly rate: string;
  /**
   * `false` when the source node's outgoing share and the target node's
   * incoming share for this part disagree (an inconsistent Manual-mode
   * entry, or an over-constrained Basic-mode graph), or when either
   * endpoint/part couldn't be resolved at all.
   */
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface PartBalance {
  readonly made: string;
  readonly used: string;
  /** `max(0, used - made)` — demand with no matching production. */
  readonly unmade: string;
  /** `max(0, made - used)` — production with no matching consumption. */
  readonly unused: string;
}

export interface SolveSummary {
  /** `@scm/gamedata` part name -> made/used/unmade/unused balance, for every part touched by any node. */
  readonly perPart: Readonly<Record<string, PartBalance>>;
  /** MW, sum of every node's positive (generating) power. The float boundary. */
  readonly powerMade: number;
  /** MW, sum of every node's negative (consuming) power, reported as a positive magnitude. */
  readonly powerUsed: number;
  readonly powerNet: number;
  /**
   * Canonical `n/d` string. Always `"0"` in this job — AWESOME Sink is a
   * specialty node kind with no representation in `SolverSnapshot` yet (see
   * `snapshot.ts`'s header); a later job that adds it should populate this
   * from `sum(sunk part rate × Part.sinkPoints)`.
   */
  readonly sinkPoints: string;
}

export interface SolveResult {
  readonly mode: SolverMode;
  /** Sorted by `nodeId` (see `ordering.ts`) regardless of the snapshot's own array order — part of this package's determinism guarantee. */
  readonly nodes: readonly NodeSolveResult[];
  /** Sorted by `edgeId`, same reasoning. */
  readonly edges: readonly EdgeSolveResult[];
  readonly summary: SolveSummary;
  /** `true` iff every node and edge is valid. `true` (vacuously) for None mode. */
  readonly valid: boolean;
  /** Flattened, human-readable copy of every node/edge issue, for a single place to check "did anything go wrong." */
  readonly warnings: readonly string[];
}
