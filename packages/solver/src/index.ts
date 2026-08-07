// Public API of `@scm/solver`. See PLAN.md §7 ("packages/solver takes a
// plain snapshot and returns plain results. No Yjs import, no DOM.") and
// jobs/017-solver-core.md's Handoff notes for the full picture.
//
// `solve()` is a synchronous, pure function: same `(snapshot, mode,
// gameData)` in, same `SolveResult` out, every time, with no I/O, no
// timers, and no mutation of its arguments. That is what lets Job 018 run
// it inside a Web Worker (or inline, or on a server) without wrapping it in
// anything beyond a debounce/cancellation layer.
import { defaultGameData, type GameData } from "@scm/gamedata";
import { solveBasic } from "./basic";
import { solveFull, type FullSolveOptions } from "./full";
import { solveManual } from "./manual";
import { solveNone } from "./none";
import type { SolveResult } from "./result";
import type { SolverMode, SolverSnapshot } from "./snapshot";

/**
 * Solves `snapshot` under `mode`:
 *   - `"none"`: PLAN.md §2's table — nothing computed, instant.
 *   - `"manual"`: entered values are the final values; validates
 *     self-consistency along edges (see `manual.ts`).
 *   - `"basic"`: entered values are limits; propagates them through the
 *     graph via a fixed, documented, deterministic algorithm (see
 *     `basic.ts`'s header comment for the exact rules).
 *   - `"full"`: entered values are limits, like Basic, but splitter/merger
 *     flow is resolved via an exact-rational LP modeling even-split
 *     preference and two-tier priority routing (see `full.ts`'s header
 *     comment). `options` (Job 023) is Full-mode-only — every other mode
 *     ignores it entirely; it's how a caller (Job 018's worker host) wires
 *     up cooperative cancellation (`options.signal`) and incremental
 *     progress reporting (`options.onProgress`) for a potentially-slow Full
 *     solve.
 *
 * `gameData` defaults to `@scm/gamedata`'s `defaultGameData` — the only
 * real game database that currently exists — but can be overridden (tests,
 * or a future multi-`game_data_version` world per PLAN.md §10.5).
 */
export function solve(
  snapshot: SolverSnapshot,
  mode: SolverMode,
  gameData: GameData = defaultGameData,
  options?: FullSolveOptions,
): SolveResult {
  switch (mode) {
    case "none":
      return solveNone();
    case "manual":
      return solveManual(snapshot, gameData);
    case "basic":
      return solveBasic(snapshot, gameData);
    case "full":
      return solveFull(snapshot, gameData, options);
  }
}

export type { LimitMode, PriorityTier, Purity, SolverEdge, SolverMode, SolverNode, SolverSnapshot } from "./snapshot";
export type { EdgeSolveResult, NodeSolveResult, PartBalance, SolveResult, SolveSummary } from "./result";
export type { FullProgressInfo, FullSolveOptions } from "./full";
export type { CancellationSignal, WaterFillProgress } from "./waterFill";
