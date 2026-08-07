/// <reference lib="webworker" />
// The actual Web Worker entry point — instantiated by `useSolver.ts` via
// `new Worker(new URL("./solverWorker.ts", import.meta.url), { type: "module" })`
// (Vite's documented worker pattern, handled automatically by both its dev
// server and production build).
//
// Deliberately a dumb, stateless request/response executor with NO
// knowledge of debouncing, caching, or cancellation — all three live on the
// main thread in `solveScheduler.ts`. Cancellation in particular is handled
// entirely from the outside via `Worker.terminate()` (see that module's
// header comment for the full reasoning) rather than anything cooperative
// in here, so this file never needs to check an abort flag mid-solve.
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
import { solve } from "@scm/solver";
import type { HostToWorkerMessage, WorkerToHostMessage } from "./protocol";

self.onmessage = (event: MessageEvent<HostToWorkerMessage>) => {
  const message = event.data;
  if (message.type !== "solve") return;

  try {
    const result = solve(message.snapshot, message.mode);
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
  }
};
