// Job 008: the React Flow canvas mounted for a single project, backed by a
// fresh, local, in-memory `@scm/ydoc` document. No fetch, no persistence —
// every reload starts a brand-new empty document (Job 015 adds loading a
// real one from the server). Job 009 adds the Recipe Chooser, opened by
// double-clicking or right-clicking the empty canvas background (PLAN.md
// §2's "Add a machine" row). Job 013 adds outposts: drill-in navigation
// (the current container is now stateful, not fixed to root — see
// `createLocalCanvasDocument`/`docContext` below), a breadcrumb trail, and
// a node-level context menu for moving nodes into/out of an outpost and
// deleting one (reparenting its contents rather than destroying them).
import { type MouseEvent as ReactMouseEvent, useCallback, useMemo, useRef, useState } from "react";

import { type SfmDocument, addContainer, createDocument, createUndoManager } from "@scm/ydoc";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Breadcrumbs } from "./Breadcrumbs";
import { CanvasDocContext, useCanvasDoc, type CanvasDocContextValue } from "./CanvasDocContext";
import { DevNodeTools } from "./DevNodeTools";
import { type ClickPoint, isDoubleClick } from "./doubleClick";
import { ConnectionEdge, useConnectionHandlers } from "./edges";
import { RecipeNode } from "./nodes";
import { BoundaryEdge, NodeContextMenu, OutpostNode, deleteOutpost, moveNodeToContainer, type NodeContextMenuState } from "./outposts";
import { RecipeChooser } from "../panels";
import { MarqueeOverlay, useMarqueeSelection, useSelectionKeybinds, useUndoRedoState } from "./selection";
import { useYjsSync, type UseYjsSyncResult } from "./useYjsSync";

// Module-level constants (not created inside the component) so React Flow
// never sees a new `nodeTypes`/`edgeTypes` object identity on every render
// — passing a fresh object each render is a documented React Flow footgun
// that triggers a console warning and forces an internal remount of every
// custom node/edge. `"recipe"` matches the `type` string
// `useYjsSync.ts`'s `nodeRecordToFlowNode` assigns to every `kind:
// "recipe"` node; `"outpost"` (Job 013) matches
// `containerToOutpostFlowNode`'s synthetic boundary nodes. `"part"` matches
// what `useYjsSync.ts` assigns to a normal direct edge (Job 011's
// `ConnectionEdge`); `"boundary"` (Job 013) matches a boundary-crossing
// projected edge (`outposts/BoundaryEdge.tsx`).
const nodeTypes = { recipe: RecipeNode, outpost: OutpostNode };
const edgeTypes = { part: ConnectionEdge, boundary: BoundaryEdge };

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

/** The parts of `CanvasDocContextValue` that are created once and never replaced for the lifetime of a `CanvasView` mount — everything else (`containerId`/`navigateToContainer`) is live React state layered on top in `CanvasView` itself (see `docContext` below), since Job 013 made "which container is being viewed" a mutable, navigable thing instead of a fixed value. */
interface StaticCanvasDoc {
  sfmDoc: SfmDocument;
  rootContainerId: string;
  undoManager: ReturnType<typeof createUndoManager>;
}

/**
 * Builds a brand-new local document plus its root container. Every other
 * container (outposts, Job 013) is created later, by the user, nested under
 * this one or under each other — this function only ever runs once, at
 * mount, and only ever creates the root.
 */
function createLocalCanvasDocument(): StaticCanvasDoc {
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
  // Job 012: one `Y.UndoManager` per open document (not per component —
  // see `CanvasDocContext.ts`'s doc comment on `undoManager`). Created here,
  // alongside `sfmDoc` itself, via `createDocument`'s companion
  // `createUndoManager` (Job 007) with its defaults: tracks only local
  // (`origin: null`) transactions, which is every mutation this app's UI
  // makes — see Job 012's Handoff notes for why that alone satisfies
  // PLAN.md's "per-user undo" for this single-local-user phase. Its scope
  // (`[settings, containers, nodes, edges]`, set in `@scm/ydoc`'s own
  // `createUndoManager`) is document-wide, not container-scoped, so
  // drilling into an outpost and undoing/redoing there already works with
  // zero changes needed for Job 013.
  const undoManager = createUndoManager(sfmDoc);
  return { sfmDoc, rootContainerId: root.id, undoManager };
}

export function CanvasView({ projectTitle, projectShortId, onBack }: CanvasViewProps) {
  // `useMemo` with no deps: exactly one document (and its one root
  // container / one undo manager) is created for the lifetime of this
  // component instance. (Not `useState(() => ...)` only because nothing
  // here ever needs to *replace* the document — a project switch unmounts
  // this component and mounts a new one via `App.tsx`'s `key`-ed view
  // switch, which is what should create a fresh doc.)
  const staticDoc = useMemo(createLocalCanvasDocument, []);
  const { sfmDoc, undoManager } = staticDoc;
  const { canUndo, canRedo } = useUndoRedoState(undoManager);

  // Job 013: "which container is currently being viewed" — starts at root,
  // changes only via `navigateToContainer` (drill-in from an outpost node's
  // double-click/"Open" affordance, or a breadcrumb click to jump back up
  // any number of levels at once). This is genuine React state (not a
  // fixed value threaded straight into the context, the way it was before
  // this job) specifically so switching it re-renders every descendant
  // that reads `containerId` off the context — most importantly
  // `useYjsSync`, which re-derives "what's visible" for the new container
  // (see that hook's own header comment).
  const [containerId, setContainerId] = useState(staticDoc.rootContainerId);
  const navigateToContainer = useCallback((id: string) => setContainerId(id), []);

  const docContext: CanvasDocContextValue = useMemo(
    () => ({
      sfmDoc,
      containerId,
      rootContainerId: staticDoc.rootContainerId,
      navigateToContainer,
      undoManager,
    }),
    [sfmDoc, containerId, staticDoc.rootContainerId, navigateToContainer, undoManager],
  );

  // Dev-only escape hatch matching Job 008's acceptance criteria wording
  // ("verify by reading the doc state after a drag in a test or dev
  // console"): exposes the live document on `window` so `listNodes(window
  // .__sfmDoc)` (import `listNodes` from `@scm/ydoc` in the console, or just
  // inspect `window.__sfmDoc.nodes.toJSON()`) works without any extra
  // tooling. Stripped from production builds by Vite's `import.meta.env.DEV`
  // dead-code elimination.
  if (import.meta.env.DEV) {
    (window as unknown as { __sfmDoc?: SfmDocument }).__sfmDoc = sfmDoc;
  }

  const sync = useYjsSync(sfmDoc, containerId);

  return (
    <CanvasDocContext.Provider value={docContext}>
      <div className="flex h-svh w-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
          <div className="min-w-0">
            <button type="button" onClick={onBack} className="text-xs text-neutral-400 underline hover:text-neutral-200">
              ← Back to projects
            </button>
            <h2 className="truncate text-sm font-medium text-neutral-200">{projectTitle}</h2>
            {/*
              Job 013: the breadcrumb trail — "drill in to edit contents...
              a breadcrumb trail" (this job's own Scope wording). `sync
              .containers` is the *whole document's* containers (not just
              the current view's children — see `useYjsSync.ts`'s
              `CanvasStoreState.containers` doc comment), which is what lets
              `computeBreadcrumbPath` walk the full ancestor chain
              regardless of how deep `containerId` currently is.
            */}
            <Breadcrumbs containers={sync.containers} currentContainerId={containerId} onNavigate={navigateToContainer} />
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {/*
              Job 012: Undo/Redo toolbar buttons, wired straight to the
              document's `Y.UndoManager` (see `createLocalCanvasDocument`
              above). `useSelectionKeybinds.ts` wires the same two actions to
              Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z / Ctrl+Y — these buttons are a
              second, discoverable entry point to the identical operation,
              not a separate code path.
            */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => undoManager.undo()}
                disabled={!canUndo}
                title="Undo (Ctrl/Cmd+Z)"
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:enabled:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ↶ Undo
              </button>
              <button
                type="button"
                onClick={() => undoManager.redo()}
                disabled={!canRedo}
                title="Redo (Ctrl/Cmd+Shift+Z)"
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:enabled:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ↷ Redo
              </button>
            </div>
            <span className="text-xs text-neutral-500">
              {projectShortId} · local in-memory document, not saved (Job 015)
            </span>
          </div>
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
 * wiring for Job 009's Recipe Chooser and Job 013's node context menu.
 * Split out from `CanvasView` only so it can sit inside
 * `<ReactFlowProvider>` and call `useReactFlow()`.
 */
function CanvasFlow({ sync }: CanvasFlowProps) {
  const { nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop } = sync;
  const { sfmDoc, containerId, undoManager, navigateToContainer } = useCanvasDoc();
  const { screenToFlowPosition } = useReactFlow();
  const [chooser, setChooser] = useState<ChooserState | null>(null);
  // Job 013: right-click-on-a-node menu state — "move to container" for a
  // real node, "open"/"delete (reparent, don't destroy)" for an outpost
  // boundary node. See `outposts/NodeContextMenu.tsx`.
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenuState | null>(null);
  // Not React state on purpose — a click-time bookkeeping ref, not something whose change should trigger a render.
  const lastPaneClickRef = useRef<ClickPoint | null>(null);

  // Job 011: drag-to-connect, edge removal via re-drag, and mismatched-part
  // rejection. See `useConnectionHandlers.ts`'s header comment for exactly
  // how the reconnect-vs-remove-by-drag split works.
  const { isValidConnection, onConnect, onReconnectStart, onReconnect, onReconnectEnd } = useConnectionHandlers(
    sfmDoc,
    containerId,
  );

  // Job 012: right-click-drag marquee multi-select. `enabled` also gates
  // off the Job 013 node context menu, mirroring the existing Recipe
  // Chooser gate, so a marquee can't start underneath either overlay.
  const { overlayRect, pointerHandlers, consumeJustDragged } = useMarqueeSelection({
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    screenToFlowPosition,
    enabled: chooser === null && nodeMenu === null,
  });

  // Job 012: cut/copy/paste/delete/select-all/undo/redo keybinds. Job 013:
  // `handleDelete` (inside this hook) now also reparents-and-removes any
  // selected outpost boundary nodes, not just real recipe nodes/edges — see
  // that hook's own comment.
  useSelectionKeybinds({
    sfmDoc,
    containerId,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    undoManager,
    enabled: chooser === null && nodeMenu === null,
  });

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
    // Job 012: a right-click that just finished dragging a marquee is not
    // "open the Recipe Chooser" (Job 009) — see `consumeJustDragged`'s doc
    // comment in `useMarqueeSelection.ts` for why this check has to happen
    // here rather than by suppressing the `contextmenu` event itself.
    if (consumeJustDragged()) return;
    openChooserAt(event.clientX, event.clientY);
  };

  // Job 013: right-click on a node (real or outpost boundary) opens the
  // "move to container" / "open outpost" / "delete outpost" menu instead of
  // the Recipe Chooser — React Flow only calls `onNodeContextMenu` for
  // clicks that land on a node, never the empty pane, so there's no
  // ambiguity with `handlePaneContextMenu` above (no `consumeJustDragged`
  // check needed here — a node-targeted right-click was never a marquee
  // candidate in the first place, since the marquee's own pointer handlers
  // apply uniformly across the whole canvas wrapper and don't care what
  // DOM element started the drag).
  const handleNodeContextMenu = (event: ReactMouseEvent, node: (typeof nodes)[number]) => {
    event.preventDefault();
    setNodeMenu({
      nodeId: node.id,
      isOutpost: Boolean(node.data.container),
      screenPosition: { x: event.clientX, y: event.clientY },
    });
  };

  const currentContainer = sync.containers.find((container) => container.id === containerId);
  const parentContainer = currentContainer?.parentId
    ? (sync.containers.find((container) => container.id === currentContainer.parentId) ?? null)
    : null;
  const siblingOutposts = sync.containers.filter(
    (container) => container.parentId === containerId && container.id !== nodeMenu?.nodeId,
  );

  return (
    // Job 012: the marquee's own pointer handlers live on this wrapper
    // (not passed as extra props into `<ReactFlow>`) so a right-click-drag
    // starting anywhere over the canvas — including on top of a node, not
    // just the empty pane — is caught, and so the overlay rect below can
    // sit as a plain sibling of `<ReactFlow>` without reaching into its
    // internals.
    <div className="relative h-full w-full" {...pointerHandlers}>
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
        onNodeContextMenu={handleNodeContextMenu}
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
      {overlayRect && <MarqueeOverlay rect={overlayRect} />}
      {nodeMenu && (
        <NodeContextMenu
          state={nodeMenu}
          siblingOutposts={siblingOutposts}
          parentContainer={parentContainer}
          onMoveToContainer={(nodeId, targetContainerId) => moveNodeToContainer(sfmDoc, nodeId, targetContainerId)}
          onOpenOutpost={(id) => navigateToContainer(id)}
          onDeleteOutpost={(id) => deleteOutpost(sfmDoc, id)}
          onClose={() => setNodeMenu(null)}
        />
      )}
    </div>
  );
}
