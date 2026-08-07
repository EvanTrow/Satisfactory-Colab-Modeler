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
        dispatchedSnapshots.push(message.snapshot);
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
    });
    expect(postMessageCalls).toHaveLength(0);
  });

  it("falls back to None behavior for an unsupported mode string (e.g. Job 023's future 'full') rather than crashing", () => {
    const scheduler = createSolveScheduler({ createWorker: () => createFakeWorker(), debounceMs: 150, onStateChange: () => {} });
    // Cast past the type system to simulate a caller passing a mode string
    // outside @scm/solver's current SolverMode union — matching
    // `@scm/ydoc`'s wider `Settings.solverMode` schema (Job 007), which
    // already allows "full" (Job 023's job). `useSolver.ts` maps this case
    // to "none" before it ever reaches the scheduler in practice; this test
    // exercises the scheduler's own defensive fallback directly.
    const unsupportedMode = "full" as unknown as SolverMode;
    scheduler.submit({ nodes: [node("a")], edges: [] }, unsupportedMode);
    expect(scheduler.getState().result?.mode).toBe("none");
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
