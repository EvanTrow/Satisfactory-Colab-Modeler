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
 *
 * `gameData` defaults to `@scm/gamedata`'s `defaultGameData` — the only
 * real game database that currently exists — but can be overridden (tests,
 * or a future multi-`game_data_version` world per PLAN.md §10.5).
 */
export function solve(
  snapshot: SolverSnapshot,
  mode: SolverMode,
  gameData: GameData = defaultGameData,
): SolveResult {
  switch (mode) {
    case "none":
      return solveNone();
    case "manual":
      return solveManual(snapshot, gameData);
    case "basic":
      return solveBasic(snapshot, gameData);
  }
}

export type { LimitMode, Purity, SolverEdge, SolverMode, SolverNode, SolverSnapshot } from "./snapshot";
export type { EdgeSolveResult, NodeSolveResult, PartBalance, SolveResult, SolveSummary } from "./result";
