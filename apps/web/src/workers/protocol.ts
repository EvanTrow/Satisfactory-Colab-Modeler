// The message contract between the main-thread host (`solveScheduler.ts`/
// `useSolver.ts`) and `solverWorker.ts`. Kept as plain, structured-clone-
// friendly data (no class instances, no functions) since it crosses the
// worker boundary via `postMessage`.
import type { FullProgressInfo, SolveResult, SolverMode, SolverSnapshot } from "@scm/solver";

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

/**
 * Job 024: Job 023's cooperative cancellation, wired through per its own
 * Handoff notes' suggested design — the worker turns this into
 * `signal.aborted = true` on the per-request signal object it constructed
 * for `solve()`'s Full-mode `options`. Only meaningful while `requestId`
 * still matches the worker's own in-flight request (a message for an
 * already-finished or already-superseded request is a harmless no-op).
 *
 * **Read `solveScheduler.ts`'s "STOP button mechanism" note before assuming
 * this is what actually halts computation.** `solverWorker.ts` is a plain,
 * fully synchronous request handler — once it calls `solve()`, the worker's
 * single JS thread is blocked until that call returns, so a `cancel`
 * message arriving DURING that call sits queued in the worker's own event
 * loop and cannot be processed (and therefore cannot flip `signal.aborted`)
 * until the synchronous call already finished, at which point it's too
 * late to matter. This message is still sent (best-effort, before the real
 * `Worker.terminate()` call — see `solveScheduler.ts`'s `stop()`) because
 * it's cheap, harmless, matches Job 023's own suggested contract, and would
 * become genuinely effective for free if a future job ever made the
 * worker's own solve invocation chunked/yielding (or backed the signal with
 * a `SharedArrayBuffer` read instead of a message) — see
 * jobs/024-priority-nodes.md's Handoff notes for the full writeup of this
 * limitation. `Worker.terminate()` (Job 018's mechanism) is what this job
 * verified actually stops computation today.
 */
export interface CancelMessage {
  readonly type: "cancel";
  readonly requestId: number;
}

export type HostToWorkerMessage = SolveRequestMessage | CancelMessage;

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

/**
 * Job 024: relays one of `@scm/solver`'s Full-mode `onProgress` callbacks
 * back to the main thread. Unlike `CancelMessage` above, this direction
 * genuinely works in real time even while the worker's own synchronous
 * `solve()` call is still running — `postMessage` calls a worker makes are
 * delivered to the main thread's own, separate event loop as they happen,
 * regardless of whether the worker thread itself is still busy computing.
 * `solverWorker.ts` throttles how often it actually sends one of these (see
 * that file's header) — `@scm/solver` itself calls `onProgress` at every
 * checkpoint with no rate limiting of its own, by design (Job 023's own
 * Handoff notes: "throttling belongs in the worker's own relay code").
 */
export interface ProgressMessage {
  readonly type: "progress";
  readonly requestId: number;
  readonly info: FullProgressInfo;
}

export type WorkerToHostMessage = SolveResultMessage | SolveErrorMessage | ProgressMessage;

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
