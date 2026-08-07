// The debounce + real-cancellation + dirty-subgraph-cache state machine —
// PLAN.md §5's three solver mitigations (points 1-3), built as one plain,
// injectable-worker-factory module so it's fully unit-testable without a
// real browser `Worker` (see `protocol.ts`'s `WorkerLike` doc comment).
//
// --- Cancellation strategy, precisely (read this before changing anything) ---
//
// Basic/Manual solves are synchronous and fast — there's no cooperative
// checkpoint inside `solve()` a cancel signal could be checked against
// (Job 017 built no such hook, deliberately: None/Manual/Basic never block
// long enough to need one). "Actually stop wasted work, not just discard a
// late result" (this job's own scope note) therefore means genuine
// PREEMPTION at the JS-engine level: `Worker.terminate()`, which the
// browser honors immediately regardless of what the worker's call stack is
// doing. This is real cancellation (the OS/engine truly stops executing
// that thread), not a cooperative flag `solve()` would need to poll — and
// it's the contract Job 023's Full mode (an LP that WILL take long enough
// to want a cooperative check too) can build on top of without changing
// this module's shape: a future slow solver could check an `AbortSignal`
// between iterations for a faster response, with `terminate()` remaining
// the backstop for whatever it doesn't catch in time.
//
// Naively calling `terminate()` and constructing a brand-new `Worker` on
// every superseded request would put that worker's module-init cost (an
// ES module graph pulling in `@scm/solver` -> `@scm/gamedata`, which parses
// and indexes a real ~136KB `game_data.json` at import time — see
// `packages/gamedata/src/data.ts`) on the critical path of every rapid edit,
// which would fight the very 150ms debounce budget this exists to protect.
// Instead, a "spare" worker is kept pre-warmed (booted, sitting idle) at all
// times: `acquireWorkerForNewRequest` terminates a genuinely-busy active
// worker and immediately promotes the already-warm spare in its place
// (zero additional cold-boot latency on that request), then kicks off
// building the NEXT spare in the background. A worker that's simply idle
// (its previous request already completed) is reused directly with no
// termination at all — cancellation only happens when there's real
// in-flight work to stop.
//
// --- Job 024: the STOP button's actual mechanism ---
//
// `stop()` below is what a user-facing "Solving… [STOP]" button calls. It
// does two things, in order: (1) best-effort, sends a `cancel` message for
// the active request (Job 023's cooperative `signal` — see `protocol.ts`'s
// `CancelMessage` doc comment for exactly why this alone is NOT sufficient
// against a synchronous in-worker `solve()` call), then (2) the same real
// `Worker.terminate()` this module already uses to preempt a superseded
// request. (2) is the mechanism this job actually verified halts
// computation — see jobs/024-priority-nodes.md's Handoff notes.
import type { FullProgressInfo, SolveResult, SolverMode, SolverSnapshot } from "@scm/solver";

import { mergeComponentResults, noneResult, splitResultByComponents, type ComponentResult } from "./mergeResults";
import { partitionSnapshot, type SolverComponent } from "./partition";
import type { WorkerLike } from "./protocol";

/**
 * Job 019 consumes exactly this — "fresh" means the currently-shown
 * `result` reflects the live document with no newer edit outstanding;
 * "stale-recomputing" means an edit has happened (still inside its
 * debounce window, or a solve is actively in flight for it) since `result`
 * was computed, so it should be shown greyed/dimmed rather than blanked
 * (PLAN.md §5 point 3) while the next one is on its way.
 */
export type SolveStaleness = "fresh" | "stale-recomputing";

export interface SolveHostState {
  /** `null` only before the very first `submit()` call has ever resolved. */
  readonly result: SolveResult | null;
  readonly staleness: SolveStaleness;
  /**
   * Job 024: the latest Full-mode progress callback relayed from the
   * active worker for the CURRENTLY in-flight request, or `null` when
   * there's nothing in flight (before the first progress message arrives,
   * after a result/error lands, or after an explicit `stop()`). Always
   * `null` for None/Manual/Basic mode — only `"full"` ever populates it.
   * `SolveStatusIndicator.tsx` reads this to render e.g. "resolving
   * splitter groups: 12/47".
   */
  readonly fullProgress: FullProgressInfo | null;
}

export interface SolveSchedulerOptions {
  /**
   * Creates a fresh worker. In production:
   * `() => new Worker(new URL("./solverWorker.ts", import.meta.url), { type: "module" })`.
   * Called once eagerly at construction (to have a spare ready from the
   * start) and again every time a spare gets promoted to active.
   */
  createWorker: () => WorkerLike;
  /** Defaults to 150ms per PLAN.md §5 point 1. */
  debounceMs?: number;
  /** Called synchronously whenever `{result, staleness}` actually changes (never redundantly for an unchanged value). */
  onStateChange: (state: SolveHostState) => void;
  /** Diagnostic-only hook: called every time a busy worker is genuinely terminated because a newer edit superseded it. Not used by production logic — wired up for the manual dirty-subgraph/cancellation verification this job's Handoff notes describe, and for test assertions. */
  onCancel?: () => void;
  /** Diagnostic-only hook: called once per debounce tick that actually sends a component (or several, batched) to a worker — i.e. NOT called when every component was a cache hit and nothing needed re-solving. This is the counter this job's Handoff notes describe instrumenting to verify, live in a browser, that editing one component never re-triggers a solve of a disconnected one. */
  onDispatch?: () => void;
}

export interface SolveScheduler {
  /**
   * Call on every relevant document change (a node/edge add-remove-update,
   * or a `Settings.solverMode` change) with the FULL current document
   * snapshot (see `buildSnapshot.ts`) and the current mode. Debounces
   * internally — safe (and expected) to call on every keystroke.
   */
  submit(snapshot: SolverSnapshot, mode: SolverMode): void;
  getState(): SolveHostState;
  /**
   * Job 024: the STOP button's entry point — cancels the currently pending
   * debounce (if any) and, if a request is genuinely in flight, sends a
   * best-effort cooperative `cancel` message and then `terminate()`s the
   * active worker (see this module's header for why `terminate()` is what
   * actually matters). Leaves `result` exactly as it was (the last
   * successfully computed answer, per PLAN.md §5 point 3's "show the last
   * result... rather than blanking") and resets `staleness` to `"fresh"`/
   * `fullProgress` to `null`, since nothing is pending anymore. A
   * subsequent document edit behaves completely normally — `stop()` has no
   * effect on future `submit()` calls.
   */
  stop(): void;
  /** Cancels any pending debounce/in-flight request and terminates both workers. Safe to call multiple times. */
  dispose(): void;
}

const DEFAULT_DEBOUNCE_MS = 150;

const SUPPORTED_MODES = new Set<SolverMode>(["none", "manual", "basic", "full"]);

export function createSolveScheduler(options: SolveSchedulerOptions): SolveScheduler {
  const { createWorker, debounceMs = DEFAULT_DEBOUNCE_MS, onStateChange, onCancel, onDispatch } = options;

  /** `mode:signature` -> that component's own solved node/edge results. Never bounded — see this job's Handoff notes on why that's an acceptable tradeoff at this app's documented scale (PLAN.md §2: "tens to low hundreds per outpost"). */
  const cache = new Map<string, ComponentResult>();

  let lastResult: SolveResult | null = null;
  let staleness: SolveStaleness = "fresh";
  let fullProgress: FullProgressInfo | null = null;

  let pendingSubmission: { snapshot: SolverSnapshot; mode: SolverMode } | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let activeWorker: WorkerLike | null = null;
  let activeBusy = false;
  let spareWorker: WorkerLike | null = createWorker();
  let requestSeq = 0;
  let activeRequestId = -1;
  let disposed = false;

  function setState(next: {
    result?: SolveResult | null;
    staleness?: SolveStaleness;
    fullProgress?: FullProgressInfo | null;
  }): void {
    let changed = false;
    if ("result" in next && next.result !== undefined && next.result !== lastResult) {
      lastResult = next.result;
      changed = true;
    }
    if (next.staleness !== undefined && next.staleness !== staleness) {
      staleness = next.staleness;
      changed = true;
    }
    if ("fullProgress" in next && next.fullProgress !== undefined && next.fullProgress !== fullProgress) {
      fullProgress = next.fullProgress;
      changed = true;
    }
    if (changed) onStateChange({ result: lastResult, staleness, fullProgress });
  }

  function submit(snapshot: SolverSnapshot, mode: SolverMode): void {
    if (disposed) return;

    // "full" (Job 023) or any future/unknown mode has no @scm/solver
    // support yet — degrade to None rather than crash or silently send an
    // unsupported mode string across the worker boundary. See this job's
    // Handoff notes: Job 023 is expected to widen `SUPPORTED_MODES` when it
    // lands, not to change this fallback's shape.
    const effectiveMode: SolverMode = SUPPORTED_MODES.has(mode) ? mode : "none";

    if (effectiveMode === "none") {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      pendingSubmission = null;
      // None is O(1) and touches no graph state at all (matches
      // `solveNone()`'s own contract) — delivered synchronously, no
      // debounce, no worker round trip.
      setState({ result: noneResult(), staleness: "fresh", fullProgress: null });
      return;
    }

    pendingSubmission = { snapshot, mode: effectiveMode };
    setState({ staleness: "stale-recomputing" });
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runDebounced, debounceMs);
  }

  function runDebounced(): void {
    debounceTimer = null;
    const submission = pendingSubmission;
    pendingSubmission = null;
    if (!submission) return;
    const { snapshot, mode } = submission;

    const components = partitionSnapshot(snapshot);
    const hitResults: ComponentResult[] = [];
    const missComponents: SolverComponent[] = [];
    for (const component of components) {
      const cached = cache.get(`${mode}:${component.signature}`);
      if (cached) hitResults.push(cached);
      else missComponents.push(component);
    }

    if (missComponents.length === 0) {
      // Every component's content was already seen under this mode —
      // nothing to send to a worker at all.
      deliver(mode, hitResults);
      return;
    }

    dispatchSolve(mode, hitResults, missComponents);
  }

  function dispatchSolve(mode: SolverMode, hitResults: ComponentResult[], missComponents: SolverComponent[]): void {
    onDispatch?.();
    const requestId = ++requestSeq;
    activeRequestId = requestId;

    const worker = acquireWorkerForNewRequest();
    activeBusy = true;
    setState({ fullProgress: null });

    worker.onmessage = (event) => {
      const message = event.data;

      // Job 024: a progress relay doesn't complete the request — the
      // worker is still busy, keep listening for the real result/error.
      // Guarded by the same `requestId` check as everything else below (a
      // progress message for an already-superseded request is a harmless
      // no-op, same as `protocol.ts`'s `CancelMessage` doc comment notes
      // for the reverse direction).
      if (message.type === "progress") {
        if (requestId === activeRequestId) setState({ fullProgress: message.info });
        return;
      }

      // Guards a theoretical race between `postMessage` and `terminate`
      // (e.g. a message already queued in the event loop before
      // `terminate()` runs) — belt-and-braces on top of the real
      // cancellation `acquireWorkerForNewRequest` performs; should never
      // actually fire stale in practice, but "ignore it if it does" costs
      // nothing.
      if (requestId !== activeRequestId) return;
      activeBusy = false;

      if (message.type === "error") {
        // `solve()` never throws (Job 017's guarantee) — this branch exists
        // for a hypothetical worker/messaging failure, not an expected
        // solver outcome. Keep showing the last good (greyed, if a newer
        // edit is already queued) result rather than discarding it for a
        // transport error.
        console.error("[solverWorker] solve request failed:", message.message);
        if (!pendingSubmission) setState({ staleness: "fresh", fullProgress: null });
        return;
      }

      const freshComponents = splitResultByComponents(message.result, missComponents);
      for (let i = 0; i < missComponents.length; i++) {
        cache.set(`${mode}:${missComponents[i]!.signature}`, freshComponents[i]!);
      }
      deliver(mode, [...hitResults, ...freshComponents]);
    };

    const missSnapshot: SolverSnapshot = {
      nodes: missComponents.flatMap((c) => c.snapshot.nodes),
      edges: missComponents.flatMap((c) => c.snapshot.edges),
    };
    worker.postMessage({ type: "solve", requestId, snapshot: missSnapshot, mode });
  }

  function deliver(mode: SolverMode, components: ComponentResult[]): void {
    const merged = mergeComponentResults(mode, components);
    setState({
      result: merged,
      // A newer edit may already be queued (still inside its own debounce
      // window) by the time this result lands — if so, this result is
      // real progress but not yet final, so stay greyed rather than
      // flashing "fresh" for one tick.
      staleness: pendingSubmission ? "stale-recomputing" : "fresh",
      fullProgress: null,
    });
  }

  function acquireWorkerForNewRequest(): WorkerLike {
    if (activeWorker && !activeBusy) {
      // Idle — the worker's previous request (if any) already completed,
      // so there's nothing to cancel; reuse it directly.
      return activeWorker;
    }
    if (activeWorker && activeBusy) {
      // Real cancellation: stop the wasted in-flight work outright rather
      // than merely ignoring its eventual result. The best-effort
      // cooperative `cancel` message (Job 024) is sent first for the same
      // reason `stop()` sends one — see this module's header.
      activeWorker.postMessage({ type: "cancel", requestId: activeRequestId });
      activeWorker.terminate();
      onCancel?.();
    }
    const promoted = spareWorker ?? createWorker();
    activeWorker = promoted;
    spareWorker = createWorker(); // immediately start warming the next spare
    return promoted;
  }

  function getState(): SolveHostState {
    return { result: lastResult, staleness, fullProgress };
  }

  function stop(): void {
    if (disposed) return;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pendingSubmission = null;

    if (activeWorker && activeBusy) {
      // Best-effort cooperative cancel first (see this module's header and
      // `protocol.ts`'s `CancelMessage` doc comment for why this alone
      // isn't sufficient), then the real, verified stop.
      activeWorker.postMessage({ type: "cancel", requestId: activeRequestId });
      activeWorker.terminate();
      onCancel?.();
      // Promote the already-warm spare immediately, mirroring
      // `acquireWorkerForNewRequest`'s own behavior, so the NEXT `submit()`
      // isn't stuck re-paying a cold boot just because the user hit STOP.
      activeWorker = spareWorker ?? createWorker();
      spareWorker = createWorker();
      activeBusy = false;
    }

    setState({ staleness: "fresh", fullProgress: null });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    activeWorker?.terminate();
    spareWorker?.terminate();
    activeWorker = null;
    spareWorker = null;
  }

  return { submit, getState, stop, dispose };
}
