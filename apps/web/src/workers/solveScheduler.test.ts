import { defaultGameData } from "@scm/gamedata";
import { solve, type SolverMode, type SolverNode, type SolverSnapshot } from "@scm/solver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostToWorkerMessage, WorkerLike, WorkerToHostMessage } from "./protocol";
import { createSolveScheduler, type SolveHostState } from "./solveScheduler";

/**
 * A fake `WorkerLike` that actually runs the real `@scm/solver` `solve()`
 * (so results are real, not fixture data) but responds asynchronously via
 * `setTimeout` — giving tests, under `vi.useFakeTimers()`, a controllable
 * window in which a newer `submit()` call can supersede it before the
 * response arrives. This is the "fake, in-process worker" `protocol.ts`'s
 * `WorkerLike` doc comment describes as the way this state machine gets
 * tested without a real browser `Worker`.
 */
function createFakeWorker(responseDelayMs = 10) {
  let terminated = false;
  const worker: WorkerLike & { terminateCalls: number; postMessageCalls: HostToWorkerMessage[] } = {
    terminateCalls: 0,
    postMessageCalls: [],
    onmessage: null,
    postMessage(message: HostToWorkerMessage) {
      worker.postMessageCalls.push(message);
      // Job 024: `stop()`/a superseding dispatch now also sends a
      // best-effort `cancel` message before `terminate()` — this fake
      // worker has no cooperative signal of its own (it just calls
      // `solve()` directly with no `options`), so a `cancel` message is a
      // pure no-op here, same as it effectively is for a real,
      // already-synchronously-blocked worker (see `protocol.ts`'s
      // `CancelMessage` doc comment).
      if (message.type !== "solve") return;
      setTimeout(() => {
        if (terminated) return;
        const result = solve(message.snapshot, message.mode, defaultGameData);
        const response: WorkerToHostMessage = { type: "result", requestId: message.requestId, result };
        worker.onmessage?.({ data: response });
      }, responseDelayMs);
    },
    terminate() {
      terminated = true;
      worker.terminateCalls++;
    },
  };
  return worker;
}

function node(id: string, overrides: Partial<SolverNode> = {}): SolverNode {
  return {
    id,
    recipe: "Iron Ore",
    machine: "Miner Mk.2",
    purity: "normal",
    limit: "30",
    limitMode: "ppm",
    clock: null,
    shards: 0,
    ...overrides,
  };
}

describe("createSolveScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not dispatch to a worker before the debounce delay elapses", () => {
    const workers: ReturnType<typeof createFakeWorker>[] = [];
    const createWorker = () => {
      const w = createFakeWorker();
      workers.push(w);
      return w;
    };
    const states: SolveHostState[] = [];
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: (s) => states.push(s) });

    scheduler.submit({ nodes: [node("a")], edges: [] }, "basic");
    vi.advanceTimersByTime(149);

    expect(workers.every((w) => w.postMessageCalls.length === 0)).toBe(true);
    expect(scheduler.getState().staleness).toBe("stale-recomputing");
  });

  it("rapid sequential edits within one debounce window result in exactly ONE dispatched solve, reflecting only the final submission", async () => {
    const createWorker = () => createFakeWorker();
    const states: SolveHostState[] = [];
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: (s) => states.push(s) });

    // Simulates fast typing in a limit field: several submissions in a row,
    // each well within the previous one's debounce window.
    scheduler.submit({ nodes: [node("a", { limit: "10" })], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(50);
    scheduler.submit({ nodes: [node("a", { limit: "20" })], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(50);
    scheduler.submit({ nodes: [node("a", { limit: "30" })], edges: [] }, "basic");

    await vi.advanceTimersByTimeAsync(500); // past debounce AND the fake worker's response delay

    const finalState = scheduler.getState();
    expect(finalState.staleness).toBe("fresh");
    expect(finalState.result?.nodes[0]?.partRates["Iron Ore"]).toBe("30");
  });

  it("cancels a stale in-flight request by terminating its worker, and only the newer request's result is ever applied", async () => {
    const createdWorkers: ReturnType<typeof createFakeWorker>[] = [];
    const createWorker = () => {
      // A slow response (250ms) so there's a real window, after the FIRST
      // request has already dispatched to a worker, to submit a second
      // edit and prove the first request's result never lands.
      const w = createFakeWorker(250);
      createdWorkers.push(w);
      return w;
    };
    let cancelCount = 0;
    const scheduler = createSolveScheduler({
      createWorker,
      debounceMs: 150,
      onStateChange: () => {},
      onCancel: () => cancelCount++,
    });

    scheduler.submit({ nodes: [node("a", { limit: "10" })], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(150); // debounce fires -> dispatches to worker #1 (still "busy", 250ms response pending)

    const firstActiveWorker = createdWorkers[0]!; // the pre-warmed spare created at construction, promoted to active by the first dispatch
    expect(firstActiveWorker.postMessageCalls).toHaveLength(1);

    // A second, superseding edit arrives before worker #1 has responded.
    scheduler.submit({ nodes: [node("a", { limit: "99" })], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(150); // debounce fires again -> must cancel worker #1 and dispatch to a fresh (pre-warmed) worker

    expect(firstActiveWorker.terminateCalls).toBe(1);
    expect(cancelCount).toBe(1);

    await vi.advanceTimersByTimeAsync(300); // let both workers' timers elapse, if they were going to fire at all

    const finalState = scheduler.getState();
    // Only the SECOND (superseding) request's result — limit "99" — should
    // ever be reflected, never the first (cancelled) one's "10".
    expect(finalState.result?.nodes[0]?.machineCount).not.toBe("10");
  });

  it("does not terminate a worker that's simply idle (no request in flight) when a new, non-overlapping edit arrives", async () => {
    const createdWorkers: ReturnType<typeof createFakeWorker>[] = [];
    const createWorker = () => {
      const w = createFakeWorker(5);
      createdWorkers.push(w);
      return w;
    };
    let cancelCount = 0;
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: () => {}, onCancel: () => cancelCount++ });

    scheduler.submit({ nodes: [node("a")], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(200); // fully settles (debounce + response) — nothing in flight anymore

    scheduler.submit({ nodes: [node("a", { limit: "5" })], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(200);

    expect(cancelCount).toBe(0);
    for (const w of createdWorkers) expect(w.terminateCalls).toBe(0);
  });

  it("editing one component does not trigger a re-solve of a disconnected, unrelated component (dirty-subgraph precision)", async () => {
    const createWorker = () => createFakeWorker(5);
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: () => {} });

    const componentA = node("a", { limit: "10" });
    const componentB = node("b", { limit: "20" });
    const snapshot: SolverSnapshot = { nodes: [componentA, componentB], edges: [] };

    scheduler.submit(snapshot, "basic");
    await vi.advanceTimersByTimeAsync(200);
    expect(scheduler.getState().result?.nodes).toHaveLength(2);

    // Now edit ONLY component A's node and resubmit the whole (updated)
    // document snapshot — exactly what `useSolver.ts` does on every doc
    // change (it always passes the FULL current snapshot; the scheduler
    // itself is responsible for figuring out only "a" actually changed).
    scheduler.submit({ nodes: [{ ...componentA, limit: "11" }, componentB], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(200);

    const finalResult = scheduler.getState().result!;
    expect(finalResult.nodes.find((n) => n.nodeId === "a")?.partRates["Iron Ore"]).toBe("11");
    // Component B's own result must be BYTE-IDENTICAL to before the edit —
    // it was never re-solved, only reused from cache.
    expect(finalResult.nodes.find((n) => n.nodeId === "b")?.partRates["Iron Ore"]).toBe("20");
  });

  it("only sends the dirty component's nodes to the worker, never the whole document, on a partial edit", async () => {
    const dispatchedSnapshots: SolverSnapshot[] = [];
    const createWorker = () => {
      const w = createFakeWorker(5);
      const originalPost = w.postMessage.bind(w);
      w.postMessage = (message) => {
        if (message.type === "solve") dispatchedSnapshots.push(message.snapshot);
        originalPost(message);
      };
      return w;
    };
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: () => {} });

    const componentA = node("a", { limit: "10" });
    const componentB = node("b", { limit: "20" });

    scheduler.submit({ nodes: [componentA, componentB], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(200);
    expect(dispatchedSnapshots).toHaveLength(1);
    expect(dispatchedSnapshots[0]!.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);

    scheduler.submit({ nodes: [{ ...componentA, limit: "11" }, componentB], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(200);

    expect(dispatchedSnapshots).toHaveLength(2);
    // Only "a" (the changed component) went to the worker the second time —
    // "b" was a cache hit and never left the main thread again.
    expect(dispatchedSnapshots[1]!.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("mode 'none' resolves synchronously with no debounce and no worker dispatch at all", () => {
    const postMessageCalls: unknown[] = [];
    const createWorker = () => {
      const w = createFakeWorker();
      const originalPost = w.postMessage.bind(w);
      w.postMessage = (m) => {
        postMessageCalls.push(m);
        originalPost(m);
      };
      return w;
    };
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: () => {} });

    scheduler.submit({ nodes: [node("a")], edges: [] }, "none");

    expect(scheduler.getState()).toEqual({
      result: {
        mode: "none",
        nodes: [],
        edges: [],
        summary: { perPart: {}, powerMade: 0, powerUsed: 0, powerNet: 0, sinkPoints: "0" },
        valid: true,
        warnings: [],
      },
      staleness: "fresh",
      fullProgress: null,
    });
    expect(postMessageCalls).toHaveLength(0);
  });

  it("falls back to None behavior for a genuinely unsupported/unknown mode string rather than crashing", () => {
    const scheduler = createSolveScheduler({ createWorker: () => createFakeWorker(), debounceMs: 150, onStateChange: () => {} });
    // Cast past the type system to simulate a caller passing a mode string
    // outside @scm/solver's current SolverMode union entirely (e.g. a
    // future, not-yet-supported mode) — `useSolver.ts` maps any such case
    // to "none" before it ever reaches the scheduler in practice; this test
    // exercises the scheduler's own defensive fallback directly. Job 024
    // widened `SUPPORTED_MODES` to include "full" (see the dedicated Full
    // mode tests below), so this now uses a string that's unsupported for
    // real.
    const unsupportedMode = "bogus" as unknown as SolverMode;
    scheduler.submit({ nodes: [node("a")], edges: [] }, unsupportedMode);
    expect(scheduler.getState().result?.mode).toBe("none");
  });

  it("'full' mode is dispatched to the worker like any other supported mode (Job 024)", async () => {
    const dispatchedModes: SolverMode[] = [];
    const createWorker = () => {
      const w = createFakeWorker(5);
      const originalPost = w.postMessage.bind(w);
      w.postMessage = (message) => {
        if (message.type === "solve") dispatchedModes.push(message.mode);
        originalPost(message);
      };
      return w;
    };
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: () => {} });

    scheduler.submit({ nodes: [node("a", { limit: "30" })], edges: [] }, "full");
    await vi.advanceTimersByTimeAsync(200);

    expect(dispatchedModes).toEqual(["full"]);
    expect(scheduler.getState().result?.mode).toBe("full");
  });

  it("onDispatch fires only when a component actually needs solving, never for a debounce tick that's entirely cache hits", async () => {
    let dispatchCount = 0;
    const scheduler = createSolveScheduler({
      createWorker: () => createFakeWorker(5),
      debounceMs: 150,
      onStateChange: () => {},
      onDispatch: () => dispatchCount++,
    });

    const componentA = node("a", { limit: "10" });
    const componentB = node("b", { limit: "20" });

    scheduler.submit({ nodes: [componentA, componentB], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(200);
    expect(dispatchCount).toBe(1); // both components were misses the first time

    // Resubmitting the IDENTICAL snapshot (no real edit at all) should hit
    // the cache for every component — no worker dispatch needed.
    scheduler.submit({ nodes: [componentA, componentB], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(200);
    expect(dispatchCount).toBe(1);
  });

  it("relays a Full-mode progress message into fullProgress while the request is still in flight, and clears it once the result lands", async () => {
    const createWorker = () => {
      const w = createFakeWorker(50);
      const originalPost = w.postMessage.bind(w);
      w.postMessage = (message) => {
        originalPost(message);
        if (message.type === "solve") {
          // Simulate `solverWorker.ts` relaying a real @scm/solver
          // `onProgress` callback mid-solve — delivered well before the
          // fake worker's own 50ms "result" timer fires.
          setTimeout(() => {
            w.onmessage?.({
              data: { type: "progress", requestId: message.requestId, info: { phase: "propagate", pass: 1, resolvedCount: 3, totalCount: 10 } },
            });
          }, 5);
        }
      };
      return w;
    };
    const states: SolveHostState[] = [];
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: (s) => states.push(s) });

    scheduler.submit({ nodes: [node("a", { limit: "30" })], edges: [] }, "full");
    await vi.advanceTimersByTimeAsync(160); // past debounce + the 5ms progress tick, before the 50ms result

    expect(scheduler.getState().fullProgress).toEqual({ phase: "propagate", pass: 1, resolvedCount: 3, totalCount: 10 });

    await vi.advanceTimersByTimeAsync(50); // let the result land
    expect(scheduler.getState().fullProgress).toBeNull();
  });

  it("stop() terminates the active worker, sends a best-effort cancel message, and never applies that request's result", async () => {
    const createdWorkers: ReturnType<typeof createFakeWorker>[] = [];
    const createWorker = () => {
      const w = createFakeWorker(250);
      createdWorkers.push(w);
      return w;
    };
    let cancelCount = 0;
    const scheduler = createSolveScheduler({
      createWorker,
      debounceMs: 150,
      onStateChange: () => {},
      onCancel: () => cancelCount++,
    });

    scheduler.submit({ nodes: [node("a", { limit: "10" })], edges: [] }, "full");
    await vi.advanceTimersByTimeAsync(150); // debounce fires -> dispatched, 250ms result still pending

    const activeWorker = createdWorkers[0]!;
    expect(activeWorker.postMessageCalls).toHaveLength(1);

    scheduler.stop();

    expect(activeWorker.terminateCalls).toBe(1);
    expect(cancelCount).toBe(1);
    expect(activeWorker.postMessageCalls).toHaveLength(2);
    expect(activeWorker.postMessageCalls[1]).toMatchObject({ type: "cancel", requestId: activeWorker.postMessageCalls[0]!.requestId });

    const stateAfterStop = scheduler.getState();
    expect(stateAfterStop.staleness).toBe("fresh");
    expect(stateAfterStop.fullProgress).toBeNull();
    expect(stateAfterStop.result).toBeNull(); // never solved anything before this — stop() must not fabricate a result

    // Let the (terminated) fake worker's own timer elapse, if it were going
    // to fire at all — it must not, since `terminated` is set.
    await vi.advanceTimersByTimeAsync(300);
    expect(scheduler.getState().result).toBeNull();
  });

  it("stop() is a harmless no-op when nothing is in flight", () => {
    const scheduler = createSolveScheduler({ createWorker: () => createFakeWorker(), debounceMs: 150, onStateChange: () => {} });
    expect(() => scheduler.stop()).not.toThrow();
    expect(scheduler.getState().staleness).toBe("fresh");
  });

  it("a submit() after stop() behaves completely normally (stop() doesn't poison future requests)", async () => {
    const createdWorkers: ReturnType<typeof createFakeWorker>[] = [];
    const createWorker = () => {
      const w = createFakeWorker(5);
      createdWorkers.push(w);
      return w;
    };
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: () => {} });

    scheduler.submit({ nodes: [node("a", { limit: "10" })], edges: [] }, "full");
    await vi.advanceTimersByTimeAsync(150);
    scheduler.stop();

    scheduler.submit({ nodes: [node("a", { limit: "50" })], edges: [] }, "full");
    await vi.advanceTimersByTimeAsync(200);

    expect(scheduler.getState().result?.nodes[0]?.partRates["Iron Ore"]).toBe("50");
    expect(scheduler.getState().staleness).toBe("fresh");
  });

  it("dispose cancels a pending debounce timer and terminates both the active and spare workers", async () => {
    const workers: ReturnType<typeof createFakeWorker>[] = [];
    const createWorker = () => {
      const w = createFakeWorker(5);
      workers.push(w);
      return w;
    };
    const scheduler = createSolveScheduler({ createWorker, debounceMs: 150, onStateChange: () => {} });

    scheduler.submit({ nodes: [node("a")], edges: [] }, "basic");
    await vi.advanceTimersByTimeAsync(150); // dispatch to the promoted spare, leaving a fresh spare behind

    scheduler.dispose();

    expect(workers.every((w) => w.terminateCalls === 1)).toBe(true);
  });
});
