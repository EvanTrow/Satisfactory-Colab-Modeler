// Job 008's "minimal manual test path" (see jobs/008-canvas-skeleton.md's
// Deliverables): a dev-only button that calls `@scm/ydoc`'s `addNode`
// directly — proving a node created purely through the ydoc API renders on
// the React Flow canvas with no page reload. This is deliberately NOT the
// Recipe Chooser (Job 009 builds that); it exists only to exercise the
// wiring in `useYjsSync.ts`.
//
// Rendered only in dev builds (`import.meta.env.DEV`) by `CanvasView.tsx` —
// see that file for the `window.__sfmDoc` console-inspection hook this
// panel's instructions refer to.
import { useEffect, useState } from "react";

import { addNode } from "@scm/ydoc";
import { Panel } from "@xyflow/react";

import { useCanvasDoc } from "./CanvasDocContext";
import { useSolverResult } from "./SolverResultContext";

let testNodeCounter = 0;

/**
 * Job 018's manual-verification hook, per that job's Notes section: this
 * dev-only panel originally called `useSolver(sfmDoc)` directly to surface
 * its live `{result, staleness}` (plus dispatch/cancel counters) for manual
 * browser verification. Job 019 switched this to read `useSolverResult()`
 * (the context `CanvasView.tsx` now populates via a single, shared
 * `useSolver` call) instead of calling `useSolver` a second time itself —
 * two independent calls would mean two independent schedulers, each with
 * its own real `Worker` pair, both solving the same document redundantly
 * (see `SolverResultContext.ts`'s header comment). This is also why the
 * dispatch/cancel counters are gone: those came from `useSolver`'s own
 * `diagnostics` argument, which only the ONE real call site
 * (`CanvasView.tsx`) can own now — `result`/`staleness` (still exposed
 * here) are enough to keep this panel useful for what it was built for.
 * Job 019 owns the real summary panel/highlighting UI — this remains
 * diagnostic tooling only, same spirit as `window.__sfmDoc` above.
 */
function SolverDebugPanel() {
  const { result, staleness } = useSolverResult();

  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as { __solveDebug?: unknown }).__solveDebug = { result, staleness };
    }
  }, [result, staleness]);

  const invalidNodeCount = result?.nodes.filter((n) => !n.valid).length ?? 0;

  return (
    <div className="mt-3 border-t border-[var(--border-default)] pt-2">
      <p className="text-[var(--text-muted)]">
        Solver (Job 018 diagnostic — real panel is Job 019): mode{" "}
        <code>{result?.mode ?? "(none yet)"}</code>,{" "}
        <span className={staleness === "stale-recomputing" ? "text-amber-500" : ""}>
          {staleness}
        </span>
      </p>
      <p className="text-[var(--text-muted)]">
        nodes solved: {result?.nodes.length ?? 0} ({invalidNodeCount} invalid)
      </p>
      <p className="mt-1 text-[var(--text-muted)]">
        Inspect <code>window.__solveDebug</code> for the full result.
      </p>
    </div>
  );
}

export function DevNodeTools() {
  const { sfmDoc, containerId } = useCanvasDoc();
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);

  function handleAddTestNode() {
    testNodeCounter += 1;
    const column = testNodeCounter % 6;
    const row = Math.floor(testNodeCounter / 6);
    // Every field below goes through `addNode` — `@scm/ydoc`'s mutation
    // helper — never a hand-built `Y.Map`. `kind: "debug"` deliberately
    // isn't one of `KNOWN_NODE_KINDS` (schema.ts's open `NodeKind` union
    // allows this) so it's unambiguous in the doc that this record came
    // from this dev harness rather than a real recipe node.
    const node = addNode(sfmDoc, {
      containerId,
      kind: "debug",
      recipe: null,
      machine: null,
      x: 80 + column * 180,
      y: 80 + row * 120,
      title: `Test node ${testNodeCounter}`,
      color: "#6366f1",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
    });
    setLastAddedId(node.id);
  }

  return (
    <Panel
      position="top-left"
      className="max-w-[240px] rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)]/95 px-3 py-2 text-xs text-[var(--text-secondary)] shadow-[var(--shadow-card)]"
    >
      <p className="mb-2 text-[var(--text-muted)]">
        Dev-only test harness (Job 008) proving the canvas↔Yjs wiring. No Recipe Chooser yet —
        that's Job 009.
      </p>
      <button
        type="button"
        onClick={handleAddTestNode}
        className="rounded-md bg-[var(--accent)] px-2 py-1 font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
      >
        Add test node (calls addNode)
      </button>
      {lastAddedId && (
        <p className="mt-2 truncate text-[var(--text-muted)]">Last added: {lastAddedId}</p>
      )}
      <p className="mt-2 text-[var(--text-muted)]">
        Drag a node, then inspect <code>window.__sfmDoc</code> in the console to confirm its x/y
        wrote back to the doc.
      </p>
      <SolverDebugPanel />
    </Panel>
  );
}
