// The landing page's read-only embed: EvanTrow's real "Modular frames"
// project, decoded once from `sampleFactorySnapshot.ts`'s baked-in bytes
// into a throwaway local `Y.Doc` (never persisted anywhere, never sent
// anywhere) and rendered through the exact same `<ReactFlow>` node/edge
// renderers and live solver the real canvas uses (`bootstrapDocument.ts`,
// `flowTypes.ts`, `useYjsSync`, `useSolver`) — so what a visitor sees here is
// never a screenshot or a hand-built mockup, and never drifts from what the
// real editor renders.
//
// "Read-only" means no edits, not no interaction — `LandingPage.tsx`'s own
// copy explicitly invites panning/zooming, so `<ReactFlow>`'s pan/zoom props
// are left at their defaults (all on) and only the *editing* surface is cut
// off: `nodesDraggable`/`nodesConnectable`/`elementsSelectable` below stop
// every react-flow-level mutation, and `pointer-events: none` scoped to
// `.react-flow__viewport` (via the wrapper's arbitrary-variant class, not
// the whole embed) stops mouse interaction with everything react-flow
// renders INSIDE the pannable/zoomable layer — `RecipeNode`'s own
// inline-editable fields (plain `<input>`s, not gated by any `<ReactFlow>`
// prop), and `ConnectionEdge`'s draggable label/waypoints (a plain
// `onMouseDown` handler of its own, also not gated by any `<ReactFlow>`
// prop — this is what first slipped through when only `.react-flow__node`
// was covered). `.react-flow__pane`, the parent that actually captures
// pan/zoom gestures, sits OUTSIDE `.react-flow__viewport` in the DOM (the
// viewport is transformed *inside* it), so blocking the viewport's own
// pointer events doesn't block the pane beneath it — a click or scroll
// anywhere over the diagram still reaches the pane and pans/zooms, it just
// can no longer land ON any node/edge content first. `useEffect` below
// additionally marks that same viewport `inert` once mounted, so a keyboard
// user tabbing through the page can't focus into any of it either —
// pointer-events alone only stops the mouse.
import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

import type { LocalUserIdentity } from "../collab";
import { useLocalPresence } from "../collab";
import { CanvasDocContext, type CanvasDocContextValue } from "../canvas/CanvasDocContext";
import { bootstrapSfmDocument } from "../canvas/persistence/bootstrapDocument";
import { SolverResultContext } from "../canvas/SolverResultContext";
import { edgeTypes, nodeTypes } from "../canvas/flowTypes";
import { useYjsSync } from "../canvas/useYjsSync";
import { useSolver } from "../workers";
import { SAMPLE_FACTORY_SNAPSHOT_BASE64 } from "./sampleFactorySnapshot";

const SAMPLE_LOCAL_USER: LocalUserIdentity = { id: "landing-sample", displayName: "", avatarUrl: "" };

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function SampleFactoryPreview() {
  // All of this is created exactly once for the component's lifetime — a
  // fresh `Y.Doc` decoded from the static snapshot, never mutated by
  // anything a visitor does (there's nothing here that *can* mutate it; see
  // this file's header comment) and never written back anywhere.
  const { sfmDoc, rootContainerId, undoManager } = useMemo(() => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base64ToUint8Array(SAMPLE_FACTORY_SNAPSHOT_BASE64));
    return bootstrapSfmDocument(doc);
  }, []);
  const awareness = useMemo(() => new Awareness(sfmDoc.doc), [sfmDoc]);
  const localPresence = useLocalPresence(awareness, SAMPLE_LOCAL_USER);

  const docContext: CanvasDocContextValue = useMemo(
    () => ({
      sfmDoc,
      containerId: rootContainerId,
      rootContainerId,
      navigateToContainer: () => {},
      undoManager,
      awareness,
      localPresence,
    }),
    [sfmDoc, rootContainerId, undoManager, awareness, localPresence],
  );

  const solver = useSolver(sfmDoc);
  const solverContextValue = useMemo(
    () => ({
      result: solver.result,
      staleness: solver.staleness,
      fullProgress: solver.fullProgress,
      stop: solver.stop,
      nodeResultById: solver.nodeResultById,
      edgeResultById: solver.edgeResultById,
    }),
    [solver.result, solver.staleness, solver.fullProgress, solver.stop, solver.nodeResultById, solver.edgeResultById],
  );

  const sync = useYjsSync(sfmDoc, rootContainerId);

  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // See this file's header comment — `.react-flow__viewport` is a layer
    // `<ReactFlow>` renders internally that this component has no JSX/prop
    // handle on, so this is the only way to reach it. Runs once: that layer
    // element itself is created once by react-flow and reused across
    // re-renders (only its children come and go), so there's no need to
    // repeat this on every render.
    const viewport = wrapperRef.current?.querySelector<HTMLDivElement>(".react-flow__viewport");
    if (viewport) viewport.inert = true;
  }, []);

  return (
    <CanvasDocContext.Provider value={docContext}>
      <SolverResultContext.Provider value={solverContextValue}>
        <div ref={wrapperRef} className="h-full w-full [&_.react-flow__viewport]:pointer-events-none">
          <ReactFlowProvider>
            <ReactFlow
              nodes={sync.nodes}
              edges={sync.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              fitView
              proOptions={{ hideAttribution: true }}
            />
          </ReactFlowProvider>
        </div>
      </SolverResultContext.Provider>
    </CanvasDocContext.Provider>
  );
}
