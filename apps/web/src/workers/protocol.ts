// The message contract between the main-thread host (`solveScheduler.ts`/
// `useSolver.ts`) and `solverWorker.ts`. Kept as plain, structured-clone-
// friendly data (no class instances, no functions) since it crosses the
// worker boundary via `postMessage`.
import type { SolveResult, SolverMode, SolverSnapshot } from "@scm/solver";

export interface SolveRequestMessage {
  readonly type: "solve";
  /** Monotonically increasing per host instance — lets a response be matched back to the request that produced it (and a stale one detected/ignored, belt-and-braces alongside the real cancellation `solveScheduler.ts` performs via `terminate()` — see that module's header). */
  readonly requestId: number;
  /**
   * Deliberately just the dirty component(s)' own nodes/edges, not the
   * whole document — "keep the snapshot payload lean" per this job's own
   * Notes section, since structured-clone cost scales with what's sent, not
   * with the document's total size.
   */
  readonly snapshot: SolverSnapshot;
  readonly mode: SolverMode;
}

export type HostToWorkerMessage = SolveRequestMessage;

export interface SolveResultMessage {
  readonly type: "result";
  readonly requestId: number;
  readonly result: SolveResult;
}

export interface SolveErrorMessage {
  readonly type: "error";
  readonly requestId: number;
  readonly message: string;
}

export type WorkerToHostMessage = SolveResultMessage | SolveErrorMessage;

/**
 * The minimal surface `solveScheduler.ts` needs from a worker — exactly
 * what a real DOM `Worker` provides. Extracted as an interface so
 * `solveScheduler.test.ts` can supply a fake, in-process implementation:
 * Vitest's `apps/web` config runs in a plain Node environment with no DOM
 * (see `vitest.config.ts`'s header comment), so a real `Worker` can't be
 * constructed inside a test at all. The debounce/cancellation state machine
 * is the thing actually worth unit-testing here — the real `Worker` wiring
 * itself (`solverWorker.ts`, and `createWorker` in `useSolver.ts`) is a
 * thin, easily-inspected pass-through, verified instead via manual Browser
 * MCP testing against the real dev server (see jobs/018-solver-worker.md's
 * Handoff notes).
 */
export interface WorkerLike {
  postMessage(message: HostToWorkerMessage): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerToHostMessage }) => void) | null;
}
