// Job 008: the React Flow canvas mounted for a single project, backed by a
// fresh, local, in-memory `@scm/ydoc` document. No fetch, no persistence —
// every reload starts a brand-new empty document (Job 015 adds loading a
// real one from the server). No real node visuals yet (Job 010) — but Job
// 009 adds the Recipe Chooser, opened by double-clicking or right-clicking
// the empty canvas background (PLAN.md §2's "Add a machine" row).
import { type MouseEvent as ReactMouseEvent, useMemo, useRef, useState } from "react";

import { type SfmDocument, addContainer, createDocument } from "@scm/ydoc";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { RecipeChooser } from "../panels";
import { CanvasDocContext, useCanvasDoc, type CanvasDocContextValue } from "./CanvasDocContext";
import { DevNodeTools } from "./DevNodeTools";
import { type ClickPoint, isDoubleClick } from "./doubleClick";
import { ConnectionEdge, useConnectionHandlers } from "./edges";
import { RecipeNode } from "./nodes";
import { useYjsSync, type UseYjsSyncResult } from "./useYjsSync";

// Module-level constants (not created inside the component) so React Flow
// never sees a new `nodeTypes`/`edgeTypes` object identity on every render
// — passing a fresh object each render is a documented React Flow footgun
// that triggers a console warning and forces an internal remount of every
// custom node/edge. `"recipe"` matches the `type` string
// `useYjsSync.ts`'s `nodeRecordToFlowNode` assigns to every `kind:
// "recipe"` node; `"part"` matches what `edgeRecordToFlowEdge` assigns to
// every edge (Job 011).
const nodeTypes = { recipe: RecipeNode };
const edgeTypes = { part: ConnectionEdge };

/**
 * How close together (in ms) and how close together (in screen px) two
 * `onPaneClick` calls need to be to count as a double-click. There's no
 * `onPaneDoubleClick` prop in `@xyflow/react` v12 (confirmed against its
 * types), so this is the manual detection Job 008's handoff notes flagged
 * as the way to get it — the alternative (a native `onDoubleClick` on the
 * wrapping `<div>`) would need its own logic to tell a background
 * double-click apart from one that landed on a node. `zoomOnDoubleClick`
 * is set to `false` below so a background double-click doesn't *also* zoom
 * the canvas while this opens the chooser. `isDoubleClick` (Job 011,
 * extracted out of this file's own former inline version so
 * `ConnectionEdge.tsx`'s label/waypoint gestures can share the exact same
 * rule) uses its own `DOUBLE_CLICK_MS`/`DOUBLE_CLICK_PX` defaults, which
 * match what this file used before extraction.
 */

interface CanvasViewProps {
  /** Route param identifying the project — display-only in this job; nothing is fetched from it yet (no backend involvement, per Job 008's scope). */
  projectTitle: string;
  projectShortId: string;
  onBack: () => void;
}

/**
 * Builds a brand-new local document plus its root container. Every node
 * created in this job's scope (there's no outpost UI yet — Job 013) lives
 * directly in this root container, so its id is threaded through
 * `CanvasDocContext` as `containerId` for `addNode` calls to use.
 */
function createLocalCanvasDocument(): CanvasDocContextValue {
  const sfmDoc = createDocument();
  const root = addContainer(sfmDoc, {
    kind: "root",
    parentId: null,
    title: "Root",
    color: "#4b5563",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  return { sfmDoc, containerId: root.id };
}

export function CanvasView({ projectTitle, projectShortId, onBack }: CanvasViewProps) {
  // `useMemo` with no deps: exactly one document is created for the
  // lifetime of this component instance. (Not `useState(() => ...)` only
  // because nothing here ever needs to *replace* the document — a project
  // switch unmounts this component and mounts a new one via `App.tsx`'s
  // `key`-ed view switch, which is what should create a fresh doc.)
  const docContext = useMemo(createLocalCanvasDocument, []);
  const { sfmDoc } = docContext;

  // Dev-only escape hatch matching this job's acceptance criteria wording
  // ("verify by reading the doc state after a drag in a test or dev
  // console"): exposes the live document on `window` so `listNodes(window
  // .__sfmDoc)` (import `listNodes` from `@scm/ydoc` in the console, or just
  // inspect `window.__sfmDoc.nodes.toJSON()`) works without any extra
  // tooling. Stripped from production builds by Vite's `import.meta.env.DEV`
  // dead-code elimination.
  if (import.meta.env.DEV) {
    (window as unknown as { __sfmDoc?: SfmDocument }).__sfmDoc = sfmDoc;
  }

  const sync = useYjsSync(sfmDoc);

  return (
    <CanvasDocContext.Provider value={docContext}>
      <div className="flex h-svh w-full flex-col">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
          <div className="min-w-0">
            <button type="button" onClick={onBack} className="text-xs text-neutral-400 underline hover:text-neutral-200">
              ← Back to projects
            </button>
            <h2 className="truncate text-sm font-medium text-neutral-200">{projectTitle}</h2>
          </div>
          <span className="shrink-0 text-xs text-neutral-500">
            {projectShortId} · local in-memory document, not saved (Job 015)
          </span>
        </div>

        <div className="relative flex-1">
          {/*
            `useReactFlow()` (needed below to convert a click's screen
            coordinates into document/flow coordinates for the Recipe
            Chooser) only works inside a `<ReactFlowProvider>` — the
            provider `<ReactFlow>` sets up internally only covers its own
            subtree, not this component's own scope. `CanvasFlow` is a
            child of the explicit provider below so it can call the hook.
          */}
          <ReactFlowProvider>
            <CanvasFlow sync={sync} />
          </ReactFlowProvider>
        </div>
      </div>
    </CanvasDocContext.Provider>
  );
}

interface CanvasFlowProps {
  sync: UseYjsSyncResult;
}

/** Pending Recipe Chooser state: both coordinate systems captured at the moment of the triggering click. */
interface ChooserState {
  /** Document/flow coordinates — where the created node will be placed. */
  flowPosition: { x: number; y: number };
  /** Viewport/screen coordinates — where the modal opens, per PLAN.md §2 ("Recipe Chooser opens" at the click point). */
  screenPosition: { x: number; y: number };
}

/**
 * The `<ReactFlow>` instance itself, plus the double/right-click-to-open
 * wiring for Job 009's Recipe Chooser. Split out from `CanvasView` only so
 * it can sit inside `<ReactFlowProvider>` and call `useReactFlow()`.
 */
function CanvasFlow({ sync }: CanvasFlowProps) {
  const { nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop } = sync;
  const { sfmDoc, containerId } = useCanvasDoc();
  const { screenToFlowPosition } = useReactFlow();
  const [chooser, setChooser] = useState<ChooserState | null>(null);
  // Not React state on purpose — a click-time bookkeeping ref, not something whose change should trigger a render.
  const lastPaneClickRef = useRef<ClickPoint | null>(null);

  // Job 011: drag-to-connect, edge removal via re-drag, and mismatched-part
  // rejection. See `useConnectionHandlers.ts`'s header comment for exactly
  // how the reconnect-vs-remove-by-drag split works.
  const { isValidConnection, onConnect, onReconnectStart, onReconnect, onReconnectEnd } = useConnectionHandlers(
    sfmDoc,
    containerId,
  );

  function openChooserAt(clientX: number, clientY: number) {
    setChooser({
      flowPosition: screenToFlowPosition({ x: clientX, y: clientY }),
      screenPosition: { x: clientX, y: clientY },
    });
  }

  // `onPaneClick` only fires for clicks that land on the empty background
  // (React Flow doesn't call it for clicks on a node), so this already
  // satisfies "double-click the *empty* canvas" without extra checks.
  const handlePaneClick = (event: ReactMouseEvent) => {
    const now: ClickPoint = { time: Date.now(), x: event.clientX, y: event.clientY };
    const last = lastPaneClickRef.current;
    lastPaneClickRef.current = now;
    if (isDoubleClick(last, now)) {
      lastPaneClickRef.current = null; // consume the pair so a third click starts a fresh count, not an immediate re-open
      openChooserAt(event.clientX, event.clientY);
    }
  };

  // Typed to match `onPaneContextMenu`'s own prop type exactly
  // (`ReactMouseEvent | MouseEvent` — React Flow calls it with a plain
  // native `MouseEvent` in some internal paths), not narrowed to just
  // `ReactMouseEvent` the way `onPaneClick`'s handler is above.
  const handlePaneContextMenu = (event: ReactMouseEvent | MouseEvent) => {
    event.preventDefault(); // suppress the native browser context menu
    openChooserAt(event.clientX, event.clientY);
  };

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onReconnectStart={onReconnectStart}
        onReconnect={onReconnect}
        onReconnectEnd={onReconnectEnd}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu}
        zoomOnDoubleClick={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls />
        <DevNodeTools />
      </ReactFlow>
      {chooser && (
        <RecipeChooser
          flowPosition={chooser.flowPosition}
          screenPosition={chooser.screenPosition}
          onClose={() => setChooser(null)}
        />
      )}
    </>
  );
}
