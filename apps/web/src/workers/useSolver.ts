// The main-thread React entry point for Job 019 (and anything else that
// wants live solve results): `useSolver(sfmDoc)` wires a `createSolveScheduler`
// instance up to the live document (whole-document `nodes`/`edges`, plus
// `Settings.solverMode`) and exposes its `{result, staleness}` — plus
// id-keyed lookup maps for fast per-node/per-edge rendering — through a
// small Zustand store, following the same "Zustand for ephemeral UI state
// derived from the Yjs doc" pattern `useYjsSync.ts` (Job 008/013) and
// `useSettings.ts` (Job 014) already established (PLAN.md §7's "State" row).
//
// Job 019's exact consumption contract:
//   const { result, staleness, nodeResultById, edgeResultById } = useSolver(sfmDoc);
//   - `result`: the full `SolveResult | null` (null only before the very
//     first solve has ever completed) — read `result.summary` for the
//     summary panel, `result.warnings` for anything wanting the full list.
//   - `staleness`: `"fresh" | "stale-recomputing"` — grey/dim the display
//     while `"stale-recomputing"`, per PLAN.md §5 point 3, rather than
//     blanking it; `result` itself is never cleared just because it's
//     stale, so there's always something to show.
//   - `nodeResultById`/`edgeResultById`: `ReadonlyMap<string, ...>` for O(1)
//     per-node/per-edge lookup while rendering the canvas (validity
//     highlighting) without Job 019 needing to re-derive its own index from
//     `result.nodes`/`.edges` on every render.
//
// Deliberately independent of `containerId`/"which outpost is currently
// being viewed" — solving operates on the whole document (see
// `buildSnapshot.ts`'s header), so navigating between outposts must NOT
// re-trigger a solve or change `nodeResultById`'s contents at all. Job 019
// looks up a given rendered node's result by id regardless of which
// container the canvas is currently showing.
import { useEffect, useMemo, useRef } from "react";

import { getSettings, type SfmDocument } from "@scm/ydoc";
import type { EdgeSolveResult, NodeSolveResult, SolveResult, SolverMode } from "@scm/solver";
import { create } from "zustand";

import { buildSolverSnapshot } from "./buildSnapshot";
import type { HostToWorkerMessage, WorkerToHostMessage } from "./protocol";
import { createSolveScheduler, type SolveHostState, type SolveStaleness } from "./solveScheduler";

interface SolveStoreState extends SolveHostState {
  setState: (state: SolveHostState) => void;
}

function createSolveStore() {
  return create<SolveStoreState>((set) => ({
    result: null,
    staleness: "fresh",
    setState: (state) => set(state),
  }));
}

function createBrowserWorker() {
  // Vite's documented worker pattern (works unmodified in both dev and a
  // production build) — see `solverWorker.ts`'s own header for why that
  // file compiles under a separate `tsconfig.worker.json`.
  const worker = new Worker(new URL("./solverWorker.ts", import.meta.url), { type: "module" });
  return {
    postMessage: (message: HostToWorkerMessage) => worker.postMessage(message),
    terminate: () => worker.terminate(),
    set onmessage(handler: ((event: { data: WorkerToHostMessage }) => void) | null) {
      worker.onmessage = handler as (this: Worker, ev: MessageEvent<WorkerToHostMessage>) => void;
    },
  };
}

export interface UseSolverResult extends SolveHostState {
  readonly nodeResultById: ReadonlyMap<string, NodeSolveResult>;
  readonly edgeResultById: ReadonlyMap<string, EdgeSolveResult>;
}

const EMPTY_NODE_RESULTS = new Map<string, NodeSolveResult>();
const EMPTY_EDGE_RESULTS = new Map<string, EdgeSolveResult>();

function indexNodes(result: SolveResult | null): ReadonlyMap<string, NodeSolveResult> {
  if (!result || result.nodes.length === 0) return EMPTY_NODE_RESULTS;
  return new Map(result.nodes.map((n) => [n.nodeId, n] as const));
}

function indexEdges(result: SolveResult | null): ReadonlyMap<string, EdgeSolveResult> {
  if (!result || result.edges.length === 0) return EMPTY_EDGE_RESULTS;
  return new Map(result.edges.map((e) => [e.edgeId, e] as const));
}

export interface UseSolverDiagnostics {
  /** Fires once per debounce tick that actually dispatches a solve to a worker (never for an all-cache-hit tick). See `solveScheduler.ts`'s own `onDispatch` doc comment — this is the counter to watch when manually verifying dirty-subgraph invalidation precision in a running browser (e.g. via `DevNodeTools.tsx`). */
  onDispatch?: () => void;
  /** Fires every time a busy worker is genuinely `terminate()`d because a newer edit superseded it — the real-cancellation counter. */
  onCancel?: () => void;
}

/**
 * Creates (once per `sfmDoc` identity) a `SolveScheduler` + its own Zustand
 * store, wires the scheduler to `sfmDoc.nodes`/`sfmDoc.edges`/
 * `sfmDoc.settings` via Yjs observers (mirroring `useYjsSync.ts`'s
 * `.observeDeep` full-resync discipline), and returns the live
 * `{result, staleness}` plus id-keyed lookup maps. A second call with a
 * different `sfmDoc` gets its own independent scheduler/worker pair, same
 * as `useYjsSync`'s per-`sfmDoc` store.
 *
 * `diagnostics` is optional and purely observational (Job 019 doesn't need
 * it at all) — kept as a second argument rather than baked into the return
 * value so the common case (`useSolver(sfmDoc)`) stays simple. Read via
 * refs internally so passing a fresh inline arrow function every render
 * (the normal React idiom) doesn't recreate the scheduler.
 */
export function useSolver(sfmDoc: SfmDocument, diagnostics?: UseSolverDiagnostics): UseSolverResult {
  const useStore = useMemo(() => createSolveStore(), [sfmDoc]);
  const result = useStore((s) => s.result);
  const staleness = useStore((s) => s.staleness);

  const diagnosticsRef = useRef(diagnostics);
  diagnosticsRef.current = diagnostics;

  useEffect(() => {
    // The scheduler is deliberately created HERE, inside the effect, not in
    // a `useMemo` above — `SolveScheduler.dispose()` is a one-way operation
    // (a disposed scheduler's `submit()` becomes a permanent no-op, so real
    // in-flight workers genuinely stop wasted work rather than lingering).
    // React 19's `<StrictMode>` (enabled in `main.tsx`) deliberately mounts
    // every effect, cleans it up, then mounts it again on first render —
    // if the scheduler lived in a memo whose IDENTITY survives that
    // cycle (memoized separately from the effect, keyed on the same
    // `[sfmDoc]` deps), the interim cleanup's `dispose()` call would
    // permanently kill it before the "real" second mount's `submit()`
    // calls ever got a chance to do anything — every subsequent edit would
    // silently no-op forever. Creating a genuinely FRESH scheduler on every
    // effect mount (discarding whichever one StrictMode's practice-mount
    // used) sidesteps that entirely, the same way a `useEffect`-owned
    // WebSocket/subscription normally has to be StrictMode-safe.
    const scheduler = createSolveScheduler({
      createWorker: createBrowserWorker,
      onStateChange: (state: SolveHostState) => useStore.getState().setState(state),
      onDispatch: () => diagnosticsRef.current?.onDispatch?.(),
      onCancel: () => diagnosticsRef.current?.onCancel?.(),
    });

    const resync = () => {
      const snapshot = buildSolverSnapshot(sfmDoc);
      // `@scm/ydoc`'s `Settings.solverMode` (Job 007's schema) already
      // allows `"full"` in anticipation of Job 023 — `@scm/solver` doesn't
      // implement it yet, so it's mapped to `"none"` here (the same
      // fallback `solveScheduler.ts` also performs defensively on its own,
      // in case of a future direct caller — see that module's
      // `SUPPORTED_MODES` check).
      const settingsMode = getSettings(sfmDoc).solverMode;
      const mode: SolverMode = settingsMode === "manual" || settingsMode === "basic" ? settingsMode : "none";
      scheduler.submit(snapshot, mode);
    };

    resync(); // the doc may already have content by the time this effect attaches

    // Whole-document observers, deliberately NOT scoped to any
    // `containerId` — see this module's header. `sfmDoc.settings.observe`
    // (shallow, matching `useSettings.ts`'s own reasoning) is enough since
    // `updateSettings` always replaces `solverMode` as a whole top-level
    // key, never mutates in place.
    sfmDoc.nodes.observeDeep(resync);
    sfmDoc.edges.observeDeep(resync);
    sfmDoc.settings.observe(resync);

    return () => {
      sfmDoc.nodes.unobserveDeep(resync);
      sfmDoc.edges.unobserveDeep(resync);
      sfmDoc.settings.unobserve(resync);
      scheduler.dispose();
    };
  }, [sfmDoc, useStore]);

  const nodeResultById = useMemo(() => indexNodes(result), [result]);
  const edgeResultById = useMemo(() => indexEdges(result), [result]);

  return { result, staleness, nodeResultById, edgeResultById };
}

export type { SolveHostState, SolveStaleness };
