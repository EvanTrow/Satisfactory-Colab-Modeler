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
import { useState } from "react";

import { addNode } from "@scm/ydoc";
import { Panel } from "@xyflow/react";

import { useCanvasDoc } from "./CanvasDocContext";

let testNodeCounter = 0;

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
      className="max-w-[240px] rounded border border-neutral-700 bg-neutral-900/90 px-3 py-2 text-xs text-neutral-300 shadow-lg"
    >
      <p className="mb-2 text-neutral-400">
        Dev-only test harness (Job 008) proving the canvas↔Yjs wiring. No Recipe Chooser yet — that's Job 009.
      </p>
      <button
        type="button"
        onClick={handleAddTestNode}
        className="rounded bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-500"
      >
        Add test node (calls addNode)
      </button>
      {lastAddedId && <p className="mt-2 truncate text-neutral-500">Last added: {lastAddedId}</p>}
      <p className="mt-2 text-neutral-500">
        Drag a node, then inspect <code>window.__sfmDoc</code> in the console to confirm its x/y wrote back to the
        doc.
      </p>
    </Panel>
  );
}
