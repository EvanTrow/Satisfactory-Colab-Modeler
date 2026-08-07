// Job 008: the React Flow canvas mounted for a single project. Job 015
// replaced the original "fresh, local, in-memory document every mount, no
// fetch, no persistence" behavior with the real thing — see
// `persistence/useProjectDocument.ts`: on mount, the project's persisted
// doc bytes are fetched and `Y.applyUpdate`-d in *before* `useYjsSync`'s
// observers ever attach, and local edits are debounced and pushed back.
// Job 009 adds the Recipe Chooser, opened by double-clicking or
// right-clicking the empty canvas background (PLAN.md §2's "Add a machine"
// row). Job 013 adds outposts: drill-in navigation (the current container
// is now stateful, not fixed to root — see `docContext` below), a
// breadcrumb trail, and a node-level context menu for moving nodes
// into/out of an outpost and deleting one (reparenting its contents rather
// than destroying them).
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

import { updateContainer, type SfmDocument, type Settings } from "@scm/ydoc";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { ProjectRole } from "../api/projects";
import {
  PresenceAvatarList,
  PresenceCursors,
  useCursorPublisher,
  useLocalPresence,
  useSelectionPublisher,
  type LocalUserIdentity,
} from "../collab";
import { SummaryPanel } from "../panels";
import { Breadcrumbs } from "./Breadcrumbs";
import { CanvasDocContext, useCanvasDoc, type CanvasDocContextValue } from "./CanvasDocContext";
import { DevNodeTools } from "./DevNodeTools";
import { SettingsMenu } from "./SettingsMenu";
import { SolverResultContext } from "./SolverResultContext";
import { type ClickPoint, isDoubleClick } from "./doubleClick";
import { ConnectionEdge, useConnectionHandlers } from "./edges";
import { RecipeNode, useAutoRound } from "./nodes";
import {
  BlueprintNode,
  BoundaryEdge,
  NodeContextMenu,
  OutpostNode,
  deleteOutpost,
  moveNodeToContainer,
  type NodeContextMenuState,
} from "./outposts";
import { ConnectionStatusIndicator } from "./persistence/ConnectionStatusIndicator";
import type { ConnectionStatus } from "./persistence/connectionStatus";
import { SaveStatusIndicator } from "./persistence/SaveStatusIndicator";
import { type SaveStatus } from "./persistence/updateQueue";
import { useProjectDocument, type StaticCanvasDoc } from "./persistence/useProjectDocument";
import { VersionPanel } from "./persistence/VersionPanel";
import { RecipeChooser } from "../panels";
import { SharingPanel } from "../sharing";
import {
  MarqueeOverlay,
  useMarqueeSelection,
  useSelectionKeybinds,
  useUndoRedoState,
} from "./selection";
import { ThemeToggle, useTheme, type ThemeMode } from "../theme";
import { useSettings } from "./useSettings";
import { useSolver } from "../workers";
import { useYjsSync, type UseYjsSyncResult } from "./useYjsSync";
import { SolveStatusIndicator } from "./SolveStatusIndicator";
import { SplurgerNode } from "./nodes";

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
const nodeTypes = { recipe: RecipeNode, outpost: OutpostNode, blueprint: BlueprintNode, splurger: SplurgerNode };
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
  /** The project's real database id (UUID) — what `persistence/useProjectDocument.ts` fetches/pushes doc bytes against. Not the same as `projectShortId` below. */
  projectId: string;
  projectTitle: string;
  projectShortId: string;
  /** The caller's role on this project — gates whether local edits get pushed to the server at all (see `useProjectDocument`'s header comment). */
  role: ProjectRole;
  /** Job 021: this logged-in user's own identity, for publishing this client's local Awareness state (`collab/useLocalPresence.ts`) — `App.tsx` derives it from `GET /auth/me`'s response once and passes it straight through. */
  localUser: LocalUserIdentity;
  onBack: () => void;
}

/**
 * `CanvasView` itself only resolves "do we have a hydrated document yet" —
 * loading/error states render their own minimal chrome (with the same back
 * button, since `onBack` should work even if the load never finishes) and
 * defer everything else (the toolbar, `<ReactFlow>`, all of Jobs 009-014's
 * hooks) to `CanvasViewReady`, which only ever mounts once `sfmDoc`/
 * `rootContainerId`/`undoManager` exist — those hooks assume a live
 * `SfmDocument` unconditionally, so they can't run before that.
 */
export function CanvasView({
  projectId,
  projectTitle,
  projectShortId,
  role,
  localUser,
  onBack,
}: CanvasViewProps) {
  const docState = useProjectDocument(projectId, role);

  if (docState.status === "loading") {
    return (
      <CanvasStatusScreen projectTitle={projectTitle} onBack={onBack}>
        Loading project…
      </CanvasStatusScreen>
    );
  }

  if (docState.status === "error") {
    return (
      <CanvasStatusScreen projectTitle={projectTitle} onBack={onBack}>
        <p className="mb-3 text-[var(--danger)]">Couldn't load this project: {docState.message}</p>
        <button
          type="button"
          onClick={docState.retry}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
        >
          Retry
        </button>
      </CanvasStatusScreen>
    );
  }

  return (
    <CanvasViewReady
      sfmDoc={docState.sfmDoc}
      rootContainerId={docState.rootContainerId}
      undoManager={docState.undoManager}
      awareness={docState.awareness}
      projectId={projectId}
      projectTitle={projectTitle}
      projectShortId={projectShortId}
      role={role}
      localUser={localUser}
      saveStatus={docState.saveStatus}
      connectionStatus={docState.connectionStatus}
      onRestored={docState.reloadAfterRestore}
      onBack={onBack}
    />
  );
}

interface CanvasStatusScreenProps {
  projectTitle: string;
  onBack: () => void;
  children: ReactNode;
}

/** The loading/error shell — same back-button affordance as the real canvas header, so a stuck load never traps the user. */
function CanvasStatusScreen({ projectTitle, onBack, children }: CanvasStatusScreenProps) {
  return (
    <div className="flex h-svh w-full flex-col bg-[var(--surface-app)] text-[var(--text-primary)]">
      <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-2">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
          >
            ← Back to projects
          </button>
          <h2 className="truncate text-sm font-medium text-[var(--text-primary)]">
            {projectTitle}
          </h2>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
        <div className="text-center">{children}</div>
      </div>
    </div>
  );
}

interface CanvasViewReadyProps extends StaticCanvasDoc {
  /** The project's real database id — `VersionPanel` talks to `/api/projects/:id/versions*` directly with this, same id `useProjectDocument` fetches/pushes doc bytes against. */
  projectId: string;
  projectTitle: string;
  projectShortId: string;
  role: ProjectRole;
  localUser: LocalUserIdentity;
  /** Live autosave state from `useProjectDocument`'s push queue — see `SaveStatusIndicator.tsx`. */
  saveStatus: SaveStatus;
  /** Job 022: the live WebSocket's own transport-level state — see `connectionStatus.ts`'s header comment for how this differs from `saveStatus`. */
  connectionStatus: ConnectionStatus;
  /** Called once a `VersionPanel` restore has succeeded server-side — forces `useProjectDocument` to fully re-hydrate from the (now-restored) server state. See that function's own doc comment for why a restore can't just be merged into the live doc. */
  onRestored: () => void;
  onBack: () => void;
}

/** Everything Jobs 008-014 built, unchanged in substance — now fed a hydrated `sfmDoc`/`rootContainerId`/`undoManager`/`awareness` from `useProjectDocument` instead of creating a fresh empty one itself. */
function CanvasViewReady({
  sfmDoc,
  rootContainerId,
  undoManager,
  awareness,
  projectId,
  projectTitle,
  projectShortId,
  role,
  localUser,
  saveStatus,
  connectionStatus,
  onRestored,
  onBack,
}: CanvasViewReadyProps) {
  const { canUndo, canRedo } = useUndoRedoState(undoManager);
  // Job 021: publishes this client's own Awareness state once (identity
  // fields — see `useLocalPresence.ts`) and hands back the setters
  // `CanvasFlow` (cursor/selection) and `RecipeNode.tsx` (editingField) call
  // — threaded through `CanvasDocContext` below rather than passed as props
  // through every intermediate component.
  const localPresence = useLocalPresence(awareness, localUser);
  // Job 014: theme toggle (app-level mechanism, see `theme/useTheme.ts`) and
  // the live `Settings` read needed for the background grid's dot spacing
  // (`useSettings.ts`) — everything else this job's snap-to-grid touches
  // reads `getSettings` synchronously at drag-stop instead (see
  // `useYjsSync.ts`/`edges/ConnectionEdge.tsx`), so this is the one place in
  // the canvas that needs a *reactive* settings value.
  const { theme, toggleTheme } = useTheme();
  const settings = useSettings(sfmDoc);

  // Job 013: "which container is currently being viewed" — starts at root,
  // changes only via `navigateToContainer` (drill-in from an outpost node's
  // double-click/"Open" affordance, or a breadcrumb click to jump back up
  // any number of levels at once). This is genuine React state (not a
  // fixed value threaded straight into the context, the way it was before
  // this job) specifically so switching it re-renders every descendant
  // that reads `containerId` off the context — most importantly
  // `useYjsSync`, which re-derives "what's visible" for the new container
  // (see that hook's own header comment).
  const [containerId, setContainerId] = useState(rootContainerId);
  const navigateToContainer = useCallback((id: string) => setContainerId(id), []);

  // Job 027: minimap show/hide — a simple local toggle, not a persisted
  // `Settings` field (per this job's own scope note: "doesn't need to be a
  // persisted setting unless you judge it should be" — a per-session UI
  // preference reads as the right scope for something this cosmetic,
  // matching how e.g. the summary/settings popovers' own `open` state is
  // also plain unpersisted local state).
  const [showMinimap, setShowMinimap] = useState(true);

  const docContext: CanvasDocContextValue = useMemo(
    () => ({
      sfmDoc,
      containerId,
      rootContainerId,
      navigateToContainer,
      undoManager,
      awareness,
      localPresence,
    }),
    [sfmDoc, containerId, rootContainerId, navigateToContainer, undoManager, awareness, localPresence],
  );

  // Job 019: Job 018's live solver output, called exactly ONCE here (not
  // inside `RecipeNode`/`SummaryPanel`, which would each spin up their own
  // scheduler/worker pair — see `SolverResultContext.ts`'s header comment)
  // and threaded through context to everything under this provider.
  // Memoized on its own fields (mirroring `docContext` above) so a Provider
  // value change — and therefore a re-render of every context consumer —
  // only happens when the solver's own output actually changes, not on
  // every unrelated re-render of this component (e.g. a theme toggle).
  const solver = useSolver(sfmDoc);
  // Job 027: auto-round — reacts to every SETTLED solve result (never a
  // stale/in-flight one) and nudges any `autoRound`-enabled node's clock
  // back to a whole machine count. Mounted here, once, for the same reason
  // `useSolver` itself is only ever called once (see this file's own
  // `solver`/`solverContextValue` comment) — see `useAutoRound.ts`'s header
  // for the full convergence argument.
  useAutoRound(sfmDoc, solver.nodeResultById, solver.staleness);
  const solverContextValue = useMemo(
    () => ({
      result: solver.result,
      staleness: solver.staleness,
      // Job 024: Full-mode progress + the STOP button's entry point,
      // threaded through the same single context so `SolveStatusIndicator`
      // (and anything else) never needs its own `useSolver` call — see
      // `SolverResultContext.ts`'s header comment on why that's a real,
      // previously-hit bug class (Job 019's Handoff notes).
      fullProgress: solver.fullProgress,
      stop: solver.stop,
      nodeResultById: solver.nodeResultById,
      edgeResultById: solver.edgeResultById,
    }),
    [
      solver.result,
      solver.staleness,
      solver.fullProgress,
      solver.stop,
      solver.nodeResultById,
      solver.edgeResultById,
    ],
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
      <SolverResultContext.Provider value={solverContextValue}>
        <div className="flex h-svh w-full flex-col bg-[var(--surface-app)] text-[var(--text-primary)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-2">
            <div className="min-w-0">
              <button
                type="button"
                onClick={onBack}
                className="text-xs text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
              >
                ← Back to projects
              </button>
              <h2 className="truncate text-sm font-medium text-[var(--text-primary)]">
                {projectTitle}
              </h2>
              {/*
              Job 013: the breadcrumb trail — "drill in to edit contents...
              a breadcrumb trail" (this job's own Scope wording). `sync
              .containers` is the *whole document's* containers (not just
              the current view's children — see `useYjsSync.ts`'s
              `CanvasStoreState.containers` doc comment), which is what lets
              `computeBreadcrumbPath` walk the full ancestor chain
              regardless of how deep `containerId` currently is.
            */}
              <Breadcrumbs
                containers={sync.containers}
                currentContainerId={containerId}
                onNavigate={navigateToContainer}
              />
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {/*
              Job 012: Undo/Redo toolbar buttons, wired straight to the
              document's `Y.UndoManager` (created in
              `persistence/useProjectDocument.ts`, once the doc has
              finished loading). `useSelectionKeybinds.ts` wires the same two actions to
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
                  className="rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:enabled:bg-[var(--surface-hover)] hover:enabled:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ↶ Undo
                </button>
                <button
                  type="button"
                  onClick={() => undoManager.redo()}
                  disabled={!canRedo}
                  title="Redo (Ctrl/Cmd+Shift+Z)"
                  className="rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:enabled:bg-[var(--surface-hover)] hover:enabled:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ↷ Redo
                </button>
              </div>
              {/* Job 024: "Solving… [STOP]" — visible only while a Full-mode solve is genuinely in flight. */}
              <SolveStatusIndicator sfmDoc={sfmDoc} />
              {/* Job 019: the real summary panel — made/used/unmade/unused, power, sink points, cost-to-build, scoped Everything/Current Outpost/Selected. */}
              <SummaryPanel
                sfmDoc={sfmDoc}
                containerId={containerId}
                nodes={sync.nodes}
                numberFormats={settings.numberFormats}
                theme={theme}
              />
              {/* Job 027: minimap show/hide — see `showMinimap`'s own comment above for why this is plain local state, not a persisted setting. */}
              <button
                type="button"
                onClick={() => setShowMinimap((v) => !v)}
                title={showMinimap ? "Hide minimap" : "Show minimap"}
                aria-pressed={showMinimap}
                className={`nodrag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-xs transition-colors ${
                  showMinimap
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                }`}
              >
                🗺
              </button>
              {/* Job 014: snap-to-grid toggle + theme toggle — the two pieces of app-level chrome this job adds. Job 019 added the solver-mode/number-format sections. */}
              <SettingsMenu sfmDoc={sfmDoc} settings={settings} />
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
              {/* Job 016: version history + restore, and the live autosave-status indicator (replaces Job 015's static "autosaves ~1.5s..." placeholder text). */}
              <VersionPanel projectId={projectId} role={role} onRestored={onRestored} />
              {/* Job 022: real sharing UI — invite links + member management, extending Job 020's owner-only routes. */}
              <SharingPanel projectId={projectId} role={role} currentUserId={localUser.id} />
              <span className="text-xs text-[var(--text-muted)]">{projectShortId}</span>
              {/* Job 021: "who's currently connected" — every role (owner/editor/viewer, Job 020) gets a live provider connection, so a viewer shows up here too. */}
              <PresenceAvatarList awareness={awareness} localUser={localUser} />
              {/* Job 022: transport-level connection state, distinct from `SaveStatusIndicator`'s save-durability signal — see `connectionStatus.ts`'s header comment. */}
              <ConnectionStatusIndicator status={connectionStatus} />
              <SaveStatusIndicator status={saveStatus} role={role} />
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
              <CanvasFlow sync={sync} settings={settings} theme={theme} showMinimap={showMinimap} />
            </ReactFlowProvider>
          </div>
        </div>
      </SolverResultContext.Provider>
    </CanvasDocContext.Provider>
  );
}

interface CanvasFlowProps {
  sync: UseYjsSyncResult;
  /** Job 014: only used to keep the background dot grid's spacing visually consistent with `Settings.gridMachine` (a separate mechanism from actual snap-to-grid, which reads settings fresh at drag-stop instead — see `useYjsSync.ts`). */
  settings: Settings;
  /**
   * Job 014: `@xyflow/react`'s `<ReactFlow>` has its *own*, entirely
   * separate light/dark mechanism — a `colorMode` prop (default `"light"`,
   * always, regardless of anything on `<html>`) that stamps a `light`/`dark`
   * class directly onto `.react-flow`'s own wrapper div and drives its
   * built-in `--xy-*` variable defaults from *that* class, not ours. Found
   * this the hard way in this job's own manual browser verification: with
   * `colorMode` left unset, `.react-flow` always carried a hardcoded
   * `"light"` class — even with `<html class="dark">` — and that class's
   * higher selector specificity (`.react-flow.light`, two classes) silently
   * beat this file's own `:root`/`.dark` global overrides of the same
   * `--xy-*` names in `index.css` (single class/pseudo-class each), so the
   * canvas background and `<Controls>` chrome stayed light-only no matter
   * what this app's own theme was set to. Passing `theme` straight through
   * closes that gap.
   */
  theme: ThemeMode;
  /** Job 027: minimap show/hide — see `CanvasViewReady`'s `showMinimap` state comment. */
  showMinimap: boolean;
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
function CanvasFlow({ sync, settings, theme, showMinimap }: CanvasFlowProps) {
  const { nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop } = sync;
  const { sfmDoc, containerId, undoManager, navigateToContainer, awareness, localPresence } = useCanvasDoc();
  const { screenToFlowPosition } = useReactFlow();
  const [chooser, setChooser] = useState<ChooserState | null>(null);

  // Job 021: local cursor publishing (throttled mousemove → Awareness) and
  // local selection publishing (React Flow's own `node.selected`, Job 012 —
  // a separate mechanism from Awareness, see `RecipeNode.tsx`'s halo
  // comment) — see `useCursorPublisher.ts`/`useSelectionPublisher.ts` for
  // why each is its own small hook rather than inline effects here.
  const cursorHandlers = useCursorPublisher(localPresence.setCursor, containerId, screenToFlowPosition);
  const selectedNodeIds = useMemo(() => nodes.filter((node) => node.selected).map((node) => node.id), [nodes]);
  useSelectionPublisher(localPresence.setSelection, selectedNodeIds);
  // Job 013: right-click-on-a-node menu state — "move to container" for a
  // real node, "open"/"delete (reparent, don't destroy)" for an outpost
  // boundary node. See `outposts/NodeContextMenu.tsx`.
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenuState | null>(null);
  // Not React state on purpose — a click-time bookkeeping ref, not something whose change should trigger a render.
  const lastPaneClickRef = useRef<ClickPoint | null>(null);

  // Job 011: drag-to-connect, edge removal via re-drag, and mismatched-part
  // rejection. See `useConnectionHandlers.ts`'s header comment for exactly
  // how the reconnect-vs-remove-by-drag split works.
  const { isValidConnection, onConnect, onReconnectStart, onReconnect, onReconnectEnd } =
    useConnectionHandlers(sfmDoc, containerId);

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
      // Job 026: a blueprint boundary node's `data.container.kind` is
      // `"blueprint"`; a plain outpost's is `"outpost"` — both are
      // `type: "outpost" | "blueprint"` flow nodes (`useYjsSync.ts`), never
      // a real recipe node's own container menu.
      containerKind: node.data.container ? (node.data.container.kind === "blueprint" ? "blueprint" : "outpost") : null,
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
    <div
      className="relative h-full w-full"
      {...pointerHandlers}
      onMouseMove={cursorHandlers.onMouseMove}
      onMouseLeave={cursorHandlers.onMouseLeave}
    >
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
        colorMode={theme}
      >
        {/*
          Job 014: the dot grid's spacing now mirrors `Settings.gridMachine`
          (the same field `useYjsSync.ts`'s `onNodeDragStop` snaps *to*) —
          two independent mechanisms (rendering a grid vs. actually snapping
          to it) kept visually consistent per this job's own scope note,
          rather than one implying the other. `color` is a real CSS custom
          property reference (`var(--grid-dot)`), not a literal — `Background`
          forwards its `color` prop into the SVG's own `style` attribute as
          `--xy-background-pattern-color-props` (confirmed against
          `@xyflow/react`'s source), so this resolves through `index.css`'s
          theme tokens exactly like any other themed value in this app,
          swapping automatically between light/dark with no JS branching
          needed here.
        */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={[settings.gridMachine.x, settings.gridMachine.y]}
          size={1.5}
          color="var(--grid-dot)"
        />
        <Controls />
        {/*
          Job 027: React Flow's built-in minimap (PLAN.md §3's later-phase
          "minimap" bullet) — themed via the SAME `--xy-minimap-*` custom-
          property override mechanism `index.css` already uses for
          `<Controls>` (Job 014's own documented gotcha: `<MiniMap>` has no
          themeable class props of its own either, and reads `colorMode`'s
          `light`/`dark` class exactly like `<Controls>` does — see this
          file's own `colorMode={theme}` prop above, already wired for
          `<Controls>` and covering this for free). `pannable`/`zoomable` so
          it doubles as a real navigation aid, not just a static overview.
        */}
        {showMinimap && <MiniMap pannable zoomable />}
        <DevNodeTools />
      </ReactFlow>
      {/* Job 021: other collaborators' live cursors, container-scoped to `containerId` — see `PresenceCursors.tsx`'s header comment for the coordinate-space handling. A plain sibling of `<ReactFlow>` (not a child), same layering approach as `MarqueeOverlay`/`RecipeChooser` below. */}
      <PresenceCursors awareness={awareness} containerId={containerId} />
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
          onMoveToContainer={(nodeId, targetContainerId) =>
            moveNodeToContainer(sfmDoc, nodeId, targetContainerId)
          }
          onOpenOutpost={(id) => navigateToContainer(id)}
          onDeleteOutpost={(id) => deleteOutpost(sfmDoc, id)}
          onConvertContainerKind={(id, kind) => updateContainer(sfmDoc, id, { kind })}
          onClose={() => setNodeMenu(null)}
        />
      )}
    </div>
  );
}
