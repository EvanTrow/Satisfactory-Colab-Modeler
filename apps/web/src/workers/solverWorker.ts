/// <reference lib="webworker" />
// The actual Web Worker entry point — instantiated by `useSolver.ts` via
// `new Worker(new URL("./solverWorker.ts", import.meta.url), { type: "module" })`
// (Vite's documented worker pattern, handled automatically by both its dev
// server and production build).
//
// Deliberately a dumb, mostly-stateless request/response executor with NO
// knowledge of debouncing or dirty-subgraph caching — both live on the main
// thread in `solveScheduler.ts`. The one bit of state this file DOES keep
// (Job 024) is the current request's cooperative cancellation signal, so a
// `cancel` message for the SAME requestId can flip it — see `protocol.ts`'s
// `CancelMessage` doc comment for the important caveat: this only takes
// effect if the cancel message is processed before/between checkpoints
// inside `solve()`, which, since `solve()` is a single synchronous call,
// in practice means only `Worker.terminate()` (still handled entirely from
// the OUTSIDE, by `solveScheduler.ts`) reliably stops an in-flight solve
// today. This file wires the cooperative path anyway per Job 023's own
// suggested contract — cheap, harmless, and forward-compatible.
//
// This is the one file in this directory that imports `@scm/solver`'s
// actual runtime (and, transitively, `@scm/gamedata`'s real
// `game_data.json`) — every other module here only imports `@scm/solver`'s
// TYPES (`import type`, erased at compile time), specifically so that cost
// stays off the main thread's bundle. See `mergeResults.ts`'s `noneResult`
// doc comment.
//
// Note on this file's `tsconfig`: it's compiled under a dedicated
// `tsconfig.worker.json` (lib: ["ES2023", "WebWorker"]) rather than
// `tsconfig.app.json` (lib: ["ES2023", "DOM", ...]) — the DOM and WebWorker
// libs both declare an incompatible global `self`/`postMessage`, so a
// worker's own global scope needs to be typechecked in isolation, the same
// way `tsconfig.node.json` already isolates `vite.config.ts`. See
// `apps/web/tsconfig.json`'s references and this directory's Handoff notes.
import { solve, type FullProgressInfo } from "@scm/solver";
import type { HostToWorkerMessage, WorkerToHostMessage } from "./protocol";

/** How often (ms) a Full-mode progress callback actually gets relayed to the main thread — `@scm/solver` calls `onProgress` at every checkpoint with no throttling of its own (Job 023's explicit design), so this file owns the rate limit per that job's Handoff notes. The very first callback for a request always goes through immediately (regardless of this interval) so the UI shows *something* right away instead of waiting a full tick on a solve that turns out to be fast. */
const PROGRESS_THROTTLE_MS = 80;

let currentRequestId: number | null = null;
let currentSignal: { aborted: boolean } | null = null;

self.onmessage = (event: MessageEvent<HostToWorkerMessage>) => {
  const message = event.data;

  if (message.type === "cancel") {
    if (currentRequestId === message.requestId && currentSignal) {
      currentSignal.aborted = true;
    }
    return;
  }
  if (message.type !== "solve") return;

  const signal = { aborted: false };
  currentRequestId = message.requestId;
  currentSignal = signal;

  let lastProgressAt = 0;
  const onProgress = (info: FullProgressInfo) => {
    const now = Date.now();
    if (lastProgressAt !== 0 && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    const response: WorkerToHostMessage = { type: "progress", requestId: message.requestId, info };
    self.postMessage(response);
  };

  try {
    // `options` is Full-mode-only per `@scm/solver`'s own contract — every
    // other mode ignores `signal`/`onProgress` entirely, so it's harmless to
    // always pass both rather than special-casing `message.mode === "full"`.
    const result = solve(message.snapshot, message.mode, undefined, { signal, onProgress });
    const response: WorkerToHostMessage = { type: "result", requestId: message.requestId, result };
    self.postMessage(response);
  } catch (err) {
    // `solve()` itself never throws (Job 017's guarantee — see
    // `packages/solver`'s Handoff notes) — this is a defensive backstop
    // against a hypothetical structured-clone or transport failure, not an
    // expected code path.
    const response: WorkerToHostMessage = {
      type: "error",
      requestId: message.requestId,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  } finally {
    if (currentRequestId === message.requestId) {
      currentRequestId = null;
      currentSignal = null;
    }
  }
};
