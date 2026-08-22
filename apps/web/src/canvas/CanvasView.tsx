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
  Lock,
  Map as MapIcon,
  Maximize,
  Redo2,
  Undo2,
  Unlock,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  getContainer,
  getEdge,
  getNode,
  getSettings,
  moveNode,
  updateContainer,
  updateWaypoint,
  type SfmDocument,
  type Settings,
} from "@scm/ydoc";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
  type FinalConnectionState,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { ProjectRole, ProjectVisibility } from "../api/projects";
import {
  PresenceAvatarList,
  PresenceCursors,
  isDraggingVisibleInContainer,
  isEdgeDraggingVisibleInContainer,
  useCursorPublisher,
  useDragPublisher,
  useLocalPresence,
  useRemotePresence,
  useSelectionPublisher,
  useSmoothedPositions,
  type AwarenessDraggingNode,
  type AwarenessDraggingWaypoint,
  type LocalUserIdentity,
  type Point,
} from "../collab";
import { RecipeChooser, type PendingConnectionInfo } from "../panels";
import { SUMMARY_SIDEBAR_WIDTH_PX, SummaryPanel } from "../panels";
import { Breadcrumbs } from "./Breadcrumbs";
import { CanvasDocContext, useCanvasDoc, type CanvasDocContextValue } from "./CanvasDocContext";
import { GenerateFactoryDialog } from "./generator";
import {
  GroupSelectionContext,
  useGroupSelection,
  type GroupSelectionContextValue,
} from "./GroupSelectionContext";
import { SettingsMenu } from "./SettingsMenu";
import { SolverResultContext } from "./SolverResultContext";
import { type ClickPoint, isDoubleClick } from "./doubleClick";
import { parsePortHandleId, storageNodePart, useConnectionHandlers } from "./edges";
import { edgeTypes, nodeTypes } from "./flowTypes";
import { useAutoRound } from "./nodes";
import {
  DeleteOutpostDialog,
  LOCKED_NODE_KINDS,
  NodeContextMenu,
  deleteOutpost,
  deleteOutpostWithContents,
  moveNodeToContainer,
  type NodeContextMenuState,
} from "./outposts";
import { ConnectionStatusIndicator } from "./persistence/ConnectionStatusIndicator";
import type { ConnectionStatus } from "./persistence/connectionStatus";
import { SaveStatusIndicator } from "./persistence/SaveStatusIndicator";
import { type SaveStatus } from "./persistence/updateQueue";
import { useProjectDocument, type StaticCanvasDoc } from "./persistence/useProjectDocument";
import { VersionPanel } from "./persistence/VersionPanel";
import { SharingPanel } from "../sharing";
import {
  MarqueeOverlay,
  parseWaypointKey,
  useMarqueeSelection,
  useSelectionKeybinds,
  useUndoRedoState,
} from "./selection";
import { snapPointToGrid } from "./snapToGrid";
import { ThemeToggle, useTheme, type ThemeMode } from "../theme";
import { useMinimapVisible } from "./useMinimapVisible";
import { useSettings } from "./useSettings";
import { useSolver } from "../workers";
import {
  useYjsSync,
  type CanvasEdgeData,
  type CanvasNode,
  type UseYjsSyncResult,
} from "./useYjsSync";
import { SolveStatusIndicator } from "./SolveStatusIndicator";

/** Node kinds whose right-click menu shows `RecipeNodeQuickSettings.tsx` (at minimum the Name field, plus recipe-only fields it gates itself). */
const QUICK_SETTINGS_KINDS = new Set(["recipe", "splurger", "sink", "depot", "storage"]);

/**
 * How long the remote-drag-in-progress overlay (a peer's live node drag,
 * and the equivalent waypoint/label drag) keeps showing its last known live
 * position after that peer's Awareness `dragging`/`edgeDragging` field
 * clears, before falling back to whatever `nodes`/`edges` (the Yjs-doc-
 * derived arrays) currently say — see `remoteDraggingByNodeId`'s own doc
 * comment for why this gap exists at all and why a fast/long drag makes it
 * visible. Comfortably above one `useRemotePresence.ts` staleness re-check
 * tick (150ms) so an expiry is actually noticed promptly, and comfortably
 * below anything a user would perceive as "stuck."
 */
const DRAG_RELEASE_GRACE_MS = 250;

// `@xyflow/react/dist/style.css`'s `.react-flow__controls-button svg` rule
// hard-codes `fill: currentColor` and `max-width/max-height: 12px` — fine for
// react-flow's own built-in (filled-shape) control icons, but it clobbers
// lucide's stroke-based outline icons into solid blobs and squashes them.
// Inline styles beat an external stylesheet's element selector (no
// `!important` needed), so this re-asserts `fill: none` and a real size on
// every custom `ControlButton` icon below.
const controlButtonIconStyle: CSSProperties = {
  fill: "none",
  width: 16,
  height: 16,
  maxWidth: "none",
  maxHeight: "none",
};

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
  /** The project's real database id (UUID) — what `persistence/useProjectDocument.ts` fetches/pushes doc bytes against. */
  projectId: string;
  /** Public-link work: the project's URL-friendly id — what `SharingPanel.tsx`'s new "Public link" section builds `/pub/:shortId` from (`sharing/api.ts`'s `buildPublicLink`). */
  projectShortId: string;
  projectTitle: string;
  /** The caller's role on this project — gates whether local edits get pushed to the server at all (see `useProjectDocument`'s header comment). */
  role: ProjectRole;
  /** Public-link work: whether this project's public link is currently on — the initial value `SharingPanel.tsx`'s toggle renders from (it owns further changes itself via `setProjectVisibility`). */
  visibility: ProjectVisibility;
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
  projectShortId,
  projectTitle,
  role,
  visibility,
  localUser,
  onBack,
}: CanvasViewProps) {
  const { t } = useTranslation("app");
  const docState = useProjectDocument(projectId, role);

  if (docState.status === "loading") {
    return (
      <CanvasStatusScreen projectTitle={projectTitle} onBack={onBack}>
        {t("canvas.loadingProject")}
      </CanvasStatusScreen>
    );
  }

  if (docState.status === "error") {
    return (
      <CanvasStatusScreen projectTitle={projectTitle} onBack={onBack}>
        <p className="mb-3 text-[var(--danger)]">
          {t("canvas.loadProjectError", { message: docState.message })}
        </p>
        <button
          type="button"
          onClick={docState.retry}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
        >
          {t("canvas.retry")}
        </button>
      </CanvasStatusScreen>
    );
  }

  return (
    <CanvasViewReady
      mode="cloud"
      sfmDoc={docState.sfmDoc}
      rootContainerId={docState.rootContainerId}
      undoManager={docState.undoManager}
      awareness={docState.awareness}
      projectId={projectId}
      projectShortId={projectShortId}
      projectTitle={projectTitle}
      role={role}
      visibility={visibility}
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

/** The loading/error shell — same back-button affordance as the real canvas header, so a stuck load never traps the user. Exported so `GuestCanvasView.tsx` can reuse the exact same chrome for its own loading/error states. */
export function CanvasStatusScreen({ projectTitle, onBack, children }: CanvasStatusScreenProps) {
  const { t } = useTranslation("app");
  return (
    <div className="flex h-svh w-full flex-col bg-[var(--surface-app)] text-[var(--text-primary)]">
      <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-2">
        <div className="min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
          >
            ← {t("canvas.backToProjects")}
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
  /**
   * Guest-mode work: `"cloud"` is the original, server-synced project path
   * (Jobs 008-022); `"guest"` is a purely local, solo document
   * (`GuestCanvasView.tsx`, `useLocalOnlyProjectDocument.ts`) with no
   * server, no collaborators, and no version history. Gates the four
   * collab/cloud-only toolbar pieces below — everything else (canvas
   * editing, solver, generator, settings, undo/redo) is genuinely mode-
   * agnostic and stays on unconditionally.
   *
   * Public-link work: `"public"` (`PublicCanvasView.tsx`,
   * `usePublicProjectDocument.ts`) is a real, server-synced, live-collab
   * project — same transport as `"cloud"` — but for a visitor with no
   * session at all. It keeps live presence (`PresenceAvatarList`/
   * `ConnectionStatusIndicator`, genuinely useful: a public viewer can see
   * who else is looking) but drops `VersionPanel`/`SharingPanel`, which are
   * owner-only REST calls an anonymous visitor could never authenticate
   * for anyway — `role` is always `"viewer"` here regardless, so every
   * write is already dropped server-side the same way any other viewer's
   * would be.
   */
  mode: "cloud" | "guest" | "public";
  /** The project's real database id — `VersionPanel` talks to `/api/projects/:id/versions*` directly with this, same id `useProjectDocument` fetches/pushes doc bytes against. Unused in guest mode. */
  projectId: string;
  /** Public-link work: `SharingPanel.tsx`'s "Public link" section needs this to build `/pub/:shortId`. Cloud-only (unused/omitted in guest and public mode, neither of which render `SharingPanel`). */
  projectShortId?: string;
  projectTitle: string;
  role: ProjectRole;
  /** Public-link work: the project's current on/off public-link state — `SharingPanel`'s initial render value. Cloud-only, same scope as `projectShortId` above. */
  visibility?: ProjectVisibility;
  localUser: LocalUserIdentity;
  /** Live autosave state — from `useProjectDocument`'s push queue in cloud mode, or `useLocalOnlyProjectDocument`'s local IndexedDB-settle approximation in guest mode. See `SaveStatusIndicator.tsx`. */
  saveStatus: SaveStatus;
  /** Job 022: the live WebSocket's own transport-level state — see `connectionStatus.ts`'s header comment for how this differs from `saveStatus`. Cloud-only — guest mode has no transport to report on. */
  connectionStatus?: ConnectionStatus;
  /** Called once a `VersionPanel` restore has succeeded server-side — forces `useProjectDocument` to fully re-hydrate from the (now-restored) server state. Cloud-only — guest mode has no version history. */
  onRestored?: () => void;
  onBack: () => void;
}

/**
 * Everything Jobs 008-014 built, unchanged in substance — now fed a hydrated
 * `sfmDoc`/`rootContainerId`/`undoManager`/`awareness` from
 * `useProjectDocument` (or, in guest mode, `useLocalOnlyProjectDocument`)
 * instead of creating a fresh empty one itself. Exported so
 * `GuestCanvasView.tsx` can render it directly with `mode="guest"` instead
 * of duplicating this whole toolbar/canvas composition.
 */
export function CanvasViewReady({
  mode,
  sfmDoc,
  rootContainerId,
  undoManager,
  awareness,
  projectId,
  projectShortId,
  projectTitle,
  role,
  visibility,
  localUser,
  saveStatus,
  connectionStatus,
  onRestored,
  onBack,
}: CanvasViewReadyProps) {
  const { t } = useTranslation("app");
  // Job 028: `UNDO`/`REDO` reuse the original string table's own keys
  // verbatim (exact 1:1 match) — only the parenthetical keybinding hint
  // ("(Ctrl/Cmd+Z)") is new `app`-namespace text, composed around it below.
  const { t: tRaw } = useTranslation();
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

  // Moved up from just before this component's `return` (still the ONLY
  // call site) so the group-selection machinery below — and `docContext`
  // further down — can both read `sync.nodes`/`sync.edges`/`sync.onNodesChange`.
  const sync = useYjsSync(sfmDoc, containerId);

  // Marquee-selected waypoints (`selection/waypointKey.ts`) + the group-drag
  // machinery that carries them along with a node or waypoint drag — see
  // `GroupSelectionContext.ts`'s header comment for why this lives in its
  // own, narrower context instead of on `docContext` below.
  const [selectedWaypoints, setSelectedWaypoints] = useState<Set<string>>(new Set());
  const [waypointGroupDragDelta, setWaypointGroupDragDelta] = useState<{
    dx: number;
    dy: number;
  } | null>(null);

  // Drops any selected waypoint whose edge no longer exists in the current
  // view, or whose index no longer exists on that edge (the waypoint was
  // deleted, its edge was removed, or the view navigated to a different
  // container — `sync.edges` is already scoped to `containerId`, see
  // `useYjsSync.ts`'s own header comment) — the waypoint-selection
  // equivalent of the "carry `selected` forward by id, drop what's gone"
  // behavior node/edge selection already gets for free from that hook's
  // own resync.
  useEffect(() => {
    if (selectedWaypoints.size === 0) return;
    const next = new Set<string>();
    for (const key of selectedWaypoints) {
      const parsed = parseWaypointKey(key);
      if (!parsed) continue;
      const edge = sync.edges.find((candidate) => candidate.id === parsed.edgeId);
      const waypointCount =
        edge && !edge.data?.projected ? (edge.data?.record?.waypoints.length ?? 0) : 0;
      if (parsed.index < waypointCount) next.add(key);
    }
    if (next.size !== selectedWaypoints.size) setSelectedWaypoints(next);
  }, [sync.edges, selectedWaypoints]);

  // The node-moving half of a WAYPOINT-initiated group drag — the other
  // direction (a NODE drag carrying selected waypoints along) lives in
  // `CanvasFlow`'s own `handleNodesChange`/`handleNodeDragStop` instead,
  // since React Flow already moves every selected node there natively and
  // only needs the waypoint side bolted on; this direction has no such
  // native mechanism to lean on; see `GroupSelectionContext.ts`.
  // `groupNodeMoveOriginRef` snapshots every currently-selected node's
  // PRE-drag position the first time `preview` is called in a gesture
  // (cleared by `commit`), so every subsequent call in the same gesture
  // computes from a fixed origin instead of compounding deltas onto an
  // already-shifted position.
  const groupNodeMoveOriginRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  // A second, independent `useDragPublisher` instance — broadcasts a
  // waypoint-driven group node move to remote peers exactly like a normal
  // node drag does (`CanvasFlow`'s own instance below handles the native-
  // drag path). Safe to run two instances: only one gesture is ever active
  // at a time, so they never race to publish conflicting state.
  const groupNodeDragPublisher = useDragPublisher(localPresence.setDragging, containerId);
  const previewGroupNodeMove = useCallback(
    (dx: number, dy: number) => {
      const selectedNodes = sync.nodes.filter((node) => node.selected);
      if (selectedNodes.length === 0) return;
      if (!groupNodeMoveOriginRef.current) {
        groupNodeMoveOriginRef.current = new Map(
          selectedNodes.map((node) => [node.id, node.position]),
        );
      }
      const origin = groupNodeMoveOriginRef.current;
      const changes: NodeChange<CanvasNode>[] = [];
      const broadcastNodes: AwarenessDraggingNode[] = [];
      for (const [nodeId, position] of origin) {
        const next = { x: position.x + dx, y: position.y + dy };
        changes.push({ id: nodeId, type: "position", position: next, dragging: true });
        broadcastNodes.push({ id: nodeId, x: next.x, y: next.y });
      }
      sync.onNodesChange(changes);
      groupNodeDragPublisher.publish(broadcastNodes);
    },
    [sync.nodes, sync.onNodesChange, groupNodeDragPublisher],
  );
  const commitGroupNodeMove = useCallback(() => {
    const origin = groupNodeMoveOriginRef.current;
    if (!origin) return;
    const dragSettings = getSettings(sfmDoc);
    for (const nodeId of origin.keys()) {
      const node = sync.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) continue;
      const position = dragSettings.snapMachines
        ? snapPointToGrid(node.position, dragSettings.gridMachine)
        : node.position;
      if (node.data.container) updateContainer(sfmDoc, nodeId, { x: position.x, y: position.y });
      else moveNode(sfmDoc, nodeId, position.x, position.y);
    }
    groupNodeMoveOriginRef.current = null;
    groupNodeDragPublisher.clear();
  }, [sync.nodes, sfmDoc, groupNodeDragPublisher]);

  const groupSelectionValue: GroupSelectionContextValue = useMemo(
    () => ({
      selectedWaypoints,
      setSelectedWaypoints,
      waypointGroupDragDelta,
      setWaypointGroupDragDelta,
      groupNodeMove: { preview: previewGroupNodeMove, commit: commitGroupNodeMove },
    }),
    [selectedWaypoints, waypointGroupDragDelta, previewGroupNodeMove, commitGroupNodeMove],
  );

  // Job 027: minimap show/hide — persisted as a `localStorage`-backed user
  // setting (see `useMinimapVisible.ts`'s header comment for why it's this
  // and not a per-document CRDT `Settings` field), matching
  // `theme/useTheme.ts`'s own account-level-preference pattern.
  const { showMinimap, toggleMinimap } = useMinimapVisible();

  // Mirrors `SummaryPanel`'s own internal pinned-sidebar state (that
  // component owns the actual on/off toggle — see its own `pinned` state
  // comment) purely so `CanvasFlow` below can shift `<Controls>` out from
  // under the pinned sidebar, which docks flush over the canvas's left
  // edge at the same `SUMMARY_SIDEBAR_WIDTH` `SummaryPanel.tsx` uses for
  // its own `w-80`.
  const [summaryPinned, setSummaryPinned] = useState(false);

  // "Generate factory": a target-item-and-rate dialog that auto-builds a
  // full production chain (`canvas/generator/`) — a one-shot action, so
  // plain local `open` state mirrors `showMinimap`'s own scope note above
  // rather than anything persisted.
  const [showGenerateFactory, setShowGenerateFactory] = useState(false);
  // Job (generate-factory fit-view): the ids handed back by the last
  // successful generate, waiting for `CanvasFlow`'s `fitView` effect below to
  // pick them up and pan/zoom the viewport to fit them. `GenerateFactoryDialog`
  // itself renders outside `<ReactFlowProvider>` (see the provider comment
  // at its call site) so it can't call `useReactFlow()` directly — this
  // state is the hand-off between the two.
  const [pendingFitNodeIds, setPendingFitNodeIds] = useState<string[] | null>(null);

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
    [
      sfmDoc,
      containerId,
      rootContainerId,
      navigateToContainer,
      undoManager,
      awareness,
      localPresence,
    ],
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

  return (
    <CanvasDocContext.Provider value={docContext}>
      <GroupSelectionContext.Provider value={groupSelectionValue}>
        <SolverResultContext.Provider value={solverContextValue}>
          <div className="flex h-svh w-full flex-col bg-[var(--surface-app)] text-[var(--text-primary)]">
            <div
              id="scm-canvas-toolbar"
              className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-2"
            >
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={onBack}
                  className="text-xs text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
                >
                  ← {t("canvas.backToProjects")}
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
                {/* Public-link work: undo/redo is meaningless (and misleading) for a read-only public viewer — there's no local edit history worth reverting, and neither action could ever persist anyway. */}
                {mode !== "public" && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => undoManager.undo()}
                      disabled={!canUndo}
                      title={t("canvas.undo", { label: tRaw("UNDO") })}
                      className="rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:enabled:bg-[var(--surface-hover)] hover:enabled:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Undo2 className="inline h-3.5 w-3.5" aria-hidden /> {tRaw("UNDO")}
                    </button>
                    <button
                      type="button"
                      onClick={() => undoManager.redo()}
                      disabled={!canRedo}
                      title={t("canvas.redo", { label: tRaw("REDO") })}
                      className="rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:enabled:bg-[var(--surface-hover)] hover:enabled:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Redo2 className="inline h-3.5 w-3.5" aria-hidden /> {tRaw("REDO")}
                    </button>
                  </div>
                )}
                {/* Job 024: "Solving… [STOP]" — visible only while a Full-mode solve is genuinely in flight. */}
                <SolveStatusIndicator sfmDoc={sfmDoc} />
                {/* Job 019: the real summary panel — made/used/unmade/unused, power, sink points, cost-to-build, scoped Everything/Current Outpost/Selected. */}
                <SummaryPanel
                  sfmDoc={sfmDoc}
                  containerId={containerId}
                  nodes={sync.nodes}
                  numberFormats={settings.numberFormats}
                  theme={theme}
                  // Calculation-validation visuals pass: reuses the exact same
                  // `pendingFitNodeIds`/`fitView` mechanism already used after
                  // Generate Factory (see `CanvasFlow`'s own effect below) —
                  // clicking an Issues-list entry just pans/zooms to it, no
                  // new camera code needed.
                  onJumpToNode={(nodeId) => setPendingFitNodeIds([nodeId])}
                  // See `summaryPinned`'s own comment above — lets
                  // `CanvasFlow` below shift `<Controls>` out from under the
                  // pinned sidebar.
                  onPinnedChange={setSummaryPinned}
                />
                {/* Job 027: minimap show/hide — see `showMinimap`'s own comment above for why this is a persisted user setting. */}
                <button
                  type="button"
                  onClick={toggleMinimap}
                  title={showMinimap ? t("canvas.hideMinimap") : t("canvas.showMinimap")}
                  aria-label={showMinimap ? t("canvas.hideMinimap") : t("canvas.showMinimap")}
                  aria-pressed={showMinimap}
                  className={`nodrag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-xs transition-colors ${
                    showMinimap
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <MapIcon className="h-4 w-4" aria-hidden />
                </button>
                {/* "Generate factory" — auto-build a production chain from a target item + desired rate (`canvas/generator/`). Public-link work: hidden for a read-only public viewer — it only ever creates new nodes/edges. */}
                {mode !== "public" && (
                <button
                  type="button"
                  onClick={() => setShowGenerateFactory(true)}
                  title={t("canvas.generateFactoryTitle")}
                  aria-label={t("canvas.generateFactory")}
                  className="nodrag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  <Wand2 className="h-4 w-4" aria-hidden />
                </button>
                )}
                {/* Job 014: snap-to-grid toggle + theme toggle — the two pieces of app-level chrome this job adds. Job 019 added the solver-mode/number-format sections. Public-link work: hidden for a read-only public viewer — every section in here mutates shared document `Settings`, none of which could ever persist for this visitor anyway. */}
                {mode !== "public" && <SettingsMenu sfmDoc={sfmDoc} settings={settings} />}
                <ThemeToggle theme={theme} onToggle={toggleTheme} />
                {/*
                Guest-mode work: version history, sharing, live presence, and
                transport-connection state all assume a server-synced
                project — none apply to a solo local guest document, so they
                only render in `mode === "cloud"`. `SaveStatusIndicator`
                stays for both: guest mode has its own local, IndexedDB-
                settle approximation of the same `saveStatus` shape (see
                `useLocalOnlyProjectDocument.ts`).
              */}
                {mode === "cloud" && (
                  <>
                    {/* Job 016: version history + restore, and the live autosave-status indicator (replaces Job 015's static "autosaves ~1.5s..." placeholder text). */}
                    <VersionPanel projectId={projectId} role={role} onRestored={onRestored!} />
                    {/* Job 022: real sharing UI — invite links + member management, extending Job 020's owner-only routes. */}
                    <SharingPanel
                      projectId={projectId}
                      projectShortId={projectShortId!}
                      role={role}
                      visibility={visibility!}
                      currentUserId={localUser.id}
                    />
                    {/* Job 021: "who's currently connected" — every role (owner/editor/viewer, Job 020) gets a live provider connection, so a viewer shows up here too. */}
                    <PresenceAvatarList awareness={awareness} localUser={localUser} />
                    {/* Job 022: transport-level connection state, distinct from `SaveStatusIndicator`'s save-durability signal — see `connectionStatus.ts`'s header comment. */}
                    <ConnectionStatusIndicator status={connectionStatus!} />
                  </>
                )}
                {mode === "guest" && (
                  <span className="rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                    {t("guestMode.canvasBadge")}
                  </span>
                )}
                {/*
                Public-link work: a real live provider connection (unlike
                guest mode), so presence + connection state are still
                meaningful and worth showing — just no version
                history/sharing management, which need an authenticated
                owner/member session this visitor doesn't have.
              */}
                {mode === "public" && (
                  <>
                    <span className="rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                      {t("publicView.badge")}
                    </span>
                    <PresenceAvatarList awareness={awareness} localUser={localUser} />
                    <ConnectionStatusIndicator status={connectionStatus!} />
                  </>
                )}
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
                <CanvasFlow
                  sync={sync}
                  settings={settings}
                  theme={theme}
                  readOnly={mode === "public"}
                  showMinimap={showMinimap}
                  summaryPinned={summaryPinned}
                  pendingFitNodeIds={pendingFitNodeIds}
                  onFitted={() => setPendingFitNodeIds(null)}
                />
              </ReactFlowProvider>
            </div>
            {showGenerateFactory && (
              <GenerateFactoryDialog
                sfmDoc={sfmDoc}
                containerId={containerId}
                numberFormats={settings.numberFormats}
                basePosition={generateFactoryBasePosition(sync.nodes)}
                solverMode={settings.solverMode}
                onClose={() => setShowGenerateFactory(false)}
                onGenerated={setPendingFitNodeIds}
              />
            )}
          </div>
        </SolverResultContext.Provider>
      </GroupSelectionContext.Provider>
    </CanvasDocContext.Provider>
  );
}

/** Where a freshly-generated chain should start — clear of whatever's already on the canvas (to the right of the current rightmost node), or the origin for an empty container. */
function generateFactoryBasePosition(nodes: readonly { position: { x: number; y: number } }[]): {
  x: number;
  y: number;
} {
  if (nodes.length === 0) return { x: 0, y: 0 };
  const maxX = Math.max(...nodes.map((n) => n.position.x));
  const minY = Math.min(...nodes.map((n) => n.position.y));
  return { x: maxX + 400, y: minY };
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
  /**
   * Public-link work: `true` only for `mode === "public"` — a genuinely
   * read-only visitor, not merely a `"viewer"`-role member (those still get
   * the existing lock/unlock toggle below; this can't be un-set from the
   * UI). Forces dragging/connecting off regardless of the toggle, and
   * suppresses every node-creating/mutating gesture (double/right-click to
   * open the Recipe Chooser, the node context menu, cut/paste/delete
   * keybinds) outright rather than relying on the server to silently drop
   * the write — see this file's own PublicCanvasView-mode comment above for
   * why "looks editable but doesn't save" was worth fixing here rather than
   * leaving as the existing (pre-existing, out of scope) viewer-role
   * behavior.
   */
  readOnly: boolean;
  /** Job 027: minimap show/hide — see `CanvasViewReady`'s `showMinimap` state comment. */
  showMinimap: boolean;
  /** Whether `SummaryPanel`'s sidebar is currently pinned open — shifts `<Controls>` right so it isn't covered. See `CanvasViewReady`'s own `summaryPinned` state comment. */
  summaryPinned: boolean;
  /** Set right after a "Generate factory" run — the new nodes' ids to pan/zoom the viewport to fit, once they've actually reached `sync.nodes` (see the effect below). `null` when there's nothing pending. */
  pendingFitNodeIds: string[] | null;
  /** Called once the pending fit-view has actually run, so `CanvasViewReady` can clear `pendingFitNodeIds`. */
  onFitted: () => void;
}

/** Pending Recipe Chooser state: both coordinate systems captured at the moment of the triggering click. */
interface ChooserState {
  /** Document/flow coordinates — where the created node will be placed. */
  flowPosition: { x: number; y: number };
  /** Viewport/screen coordinates — where the modal opens, per PLAN.md §2 ("Recipe Chooser opens" at the click point). */
  screenPosition: { x: number; y: number };
  /** Set when this chooser was opened by dragging a connection out to empty canvas — see `handleConnectEnd` below. */
  pendingConnection?: PendingConnectionInfo | null;
}

/** Reads a native pointer event's client coordinates — `onConnectEnd`'s `event` is typed `MouseEvent | TouchEvent`, unlike every other click handler in this file which only ever sees a `MouseEvent`. */
function eventClientPoint(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  const touch = event.changedTouches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : { x: 0, y: 0 };
}

/**
 * The `<ReactFlow>` instance itself, plus the double/right-click-to-open
 * wiring for Job 009's Recipe Chooser and Job 013's node context menu.
 * Split out from `CanvasView` only so it can sit inside
 * `<ReactFlowProvider>` and call `useReactFlow()`.
 */
function CanvasFlow({
  sync,
  settings,
  theme,
  readOnly,
  showMinimap,
  summaryPinned,
  pendingFitNodeIds,
  onFitted,
}: CanvasFlowProps) {
  const { t } = useTranslation("app");
  const { nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop } = sync;
  const { sfmDoc, containerId, undoManager, navigateToContainer, awareness, localPresence } =
    useCanvasDoc();
  // Safety net for a React Flow measurement race (`@xyflow/system`'s
  // `adoptUserNodes`/`ResizeObserver`-driven `internals.handleBounds`):
  // under a burst of doc-driven `nodes`/`edges` updates — most reliably, a
  // multi-selection drag of several machines at once, especially several
  // production chains deep — React Flow can end up with a node stuck
  // "not yet measured" (rendered `visibility: hidden`) or an edge that can't
  // resolve its endpoints' handle positions and simply doesn't render,
  // *even after the burst stops* (confirmed by direct testing: the
  // underlying document is never actually missing anything — a page reload
  // always shows everything correctly, immediately). `useYjsSync.ts`'s own
  // per-node/edge object-identity cache and `onNodeDragStop`'s single-
  // transaction batching both cut down how often and how hard this gets
  // triggered, but neither can fully rule out React Flow's own internal
  // timing losing this race under a big enough burst. This effect is the
  // actual recovery: once `nodes`/`edges` stop changing for a moment (the
  // debounce below), explicitly ask React Flow to recheck every current
  // node's measurements — self-healing any node/edge that got stuck,
  // without requiring a manual page refresh.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    if (nodes.length === 0) return;
    const nodeIds = nodes.map((node) => node.id);
    const timer = setTimeout(() => updateNodeInternals(nodeIds), 300);
    return () => clearTimeout(timer);
  }, [nodes, updateNodeInternals]);
  const {
    selectedWaypoints,
    setSelectedWaypoints,
    waypointGroupDragDelta,
    setWaypointGroupDragDelta,
  } = useGroupSelection();
  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = useReactFlow();

  // Job (generate-factory fit-view): once a generate's own nodes have all
  // landed in `sync.nodes` (Yjs's `observeDeep` → Zustand hand-off is
  // synchronous, but React Flow's internal node registry — what `fitView`'s
  // bounds computation actually reads — only catches up a render later, so
  // this can't just run inline right after `applyFactoryPlan` returns), pan
  // /zoom the viewport to fit exactly that batch, then clear the pending
  // state so this doesn't re-fire on every subsequent node change.
  useEffect(() => {
    if (!pendingFitNodeIds || pendingFitNodeIds.length === 0) return;
    const nodeIds = new Set(nodes.map((node) => node.id));
    if (!pendingFitNodeIds.every((id) => nodeIds.has(id))) return;
    void fitView({ nodes: pendingFitNodeIds.map((id) => ({ id })), padding: 0.2, duration: 400 });
    onFitted();
  }, [pendingFitNodeIds, nodes, fitView, onFitted]);
  const [chooser, setChooser] = useState<ChooserState | null>(null);
  // Job (icon migration): backs the custom lock/unlock `ControlButton` below —
  // `<Controls>`'s own built-in interactive-toggle button has no icon-swap
  // prop, so its zoom/fit-view/interactive buttons are disabled via
  // `showZoom`/`showFitView`/`showInteractive` and rebuilt as `ControlButton`
  // children with lucide icons instead, wired straight to `<ReactFlow>`'s
  // `nodesDraggable`/`nodesConnectable`/`elementsSelectable` props.
  const [interactive, setInteractive] = useState(true);
  // Public-link work: `readOnly` always wins over the lock/unlock toggle
  // above (there's no UI to flip it back on in that mode — see this
  // component's own `readOnly` prop doc comment).
  const editingEnabled = interactive && !readOnly;

  // Job 021: local cursor publishing (throttled mousemove → Awareness) and
  // local selection publishing (React Flow's own `node.selected`, Job 012 —
  // a separate mechanism from Awareness, see `RecipeNode.tsx`'s halo
  // comment) — see `useCursorPublisher.ts`/`useSelectionPublisher.ts` for
  // why each is its own small hook rather than inline effects here.
  const cursorHandlers = useCursorPublisher(
    localPresence.setCursor,
    containerId,
    screenToFlowPosition,
  );
  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => node.selected).map((node) => node.id),
    [nodes],
  );
  useSelectionPublisher(localPresence.setSelection, selectedNodeIds);

  // Live drag broadcasting: every in-progress drag position (not just the
  // single write `onNodeDragStop` makes into the Yjs doc once the gesture
  // ends) gets throttled-published over Awareness, so other peers see a
  // node — or a Job 013 outpost boundary node, same id space —
  // glide across the canvas in real time as it moves. `draggingPositionsRef`
  // holds every id *this* client currently has in flight (React Flow fires
  // one `onNodesChange` batch per pointer-move with a `NodePositionChange`
  // per moved node, `dragging: true`, and a final `dragging: false` batch
  // right before `onNodeDragStop`); the remote-overlay merge below reads its
  // keys so a peer's slightly-stale broadcast of a node this client is
  // *itself* dragging never fights the local gesture.
  const dragPublisher = useDragPublisher(localPresence.setDragging, containerId);
  const draggingPositionsRef = useRef<Map<string, AwarenessDraggingNode>>(new Map());
  const handleNodesChange = useCallback<UseYjsSyncResult["onNodesChange"]>(
    (changes) => {
      onNodesChange(changes);
      let sawPositionChange = false;
      for (const change of changes) {
        if (change.type !== "position") continue;
        sawPositionChange = true;
        if (change.dragging === false) {
          draggingPositionsRef.current.delete(change.id);
        } else if (change.dragging && change.position) {
          draggingPositionsRef.current.set(change.id, {
            id: change.id,
            x: change.position.x,
            y: change.position.y,
          });
        }
      }
      if (!sawPositionChange) return;

      if (draggingPositionsRef.current.size === 0) {
        dragPublisher.clear();
        if (waypointGroupDragDelta) setWaypointGroupDragDelta(null);
        return;
      }

      // Selected waypoints ride along with a NATIVE node drag too — see
      // `GroupSelectionContext.ts`'s header comment. Delta computed from
      // whichever dragging node happens to come first out of the map;
      // every node in a rigid multi-select drag moves by the identical
      // delta (confirmed against `@xyflow/system`'s own drag math, and
      // already relied on by `useYjsSync.ts`'s own connected-pair waypoint
      // follow logic), so any one of them works. Broadcast alongside the
      // node positions below (not a separate publish call) so a remote
      // peer sees them glide together in the SAME awareness update,
      // instead of only jumping to their final spot once this drag commits
      // to the doc — that broadcast-less gap is exactly what made a
      // group-dragged waypoint "not showing the position in realtime" for
      // remote viewers, even though it moved for the person doing the
      // dragging.
      const broadcastWaypoints: AwarenessDraggingWaypoint[] = [];
      if (selectedWaypoints.size > 0) {
        const primary = draggingPositionsRef.current.values().next().value as
          | AwarenessDraggingNode
          | undefined;
        const persisted = primary ? (getNode(sfmDoc, primary.id) ?? getContainer(sfmDoc, primary.id)) : undefined;
        const dx = primary && persisted ? primary.x - persisted.x : 0;
        const dy = primary && persisted ? primary.y - persisted.y : 0;
        const hasDelta = persisted && (dx !== 0 || dy !== 0);
        setWaypointGroupDragDelta(hasDelta ? { dx, dy } : null);
        if (hasDelta) {
          // Ids currently dragging in THIS gesture — a waypoint whose
          // edge's BOTH endpoints are in this set is already covered by
          // `ConnectionEdge.tsx`'s own two-endpoint-rigid-move `liveDelta`
          // (which every peer, local or remote, derives independently from
          // live-vs-persisted NODE position — no broadcast needed for it),
          // so it's skipped here to avoid double-shifting it on the
          // receiving end, mirroring `handleNodeDragStop`'s identical
          // commit-time guard below.
          const draggedIds = new Set(draggingPositionsRef.current.keys());
          for (const key of selectedWaypoints) {
            const parsed = parseWaypointKey(key);
            if (!parsed) continue;
            const edgeRecord = getEdge(sfmDoc, parsed.edgeId);
            if (!edgeRecord) continue;
            if (draggedIds.has(edgeRecord.fromNode) && draggedIds.has(edgeRecord.toNode)) continue;
            const waypoint = edgeRecord.waypoints[parsed.index];
            if (!waypoint) continue;
            broadcastWaypoints.push({
              edgeId: parsed.edgeId,
              index: parsed.index,
              x: waypoint.x + dx,
              y: waypoint.y + dy,
            });
          }
        }
      }

      dragPublisher.publish(Array.from(draggingPositionsRef.current.values()), broadcastWaypoints);
    },
    [onNodesChange, dragPublisher, selectedWaypoints, sfmDoc, waypointGroupDragDelta, setWaypointGroupDragDelta],
  );
  const handleNodeDragStop = useCallback<UseYjsSyncResult["onNodeDragStop"]>(
    (event, node, draggedNodes) => {
      // Defensive clear alongside the `dragging: false` handling above — the
      // gesture is unambiguously over the moment this fires either way.
      draggingPositionsRef.current.clear();
      dragPublisher.clear();

      // Commits selected waypoints' final positions alongside this drag —
      // computed BEFORE `onNodeDragStop` below commits the new node
      // positions, since this needs the delta between the OLD persisted
      // position and the NEW (about-to-be-committed) one. Same "any one
      // dragged node's delta" reasoning as `handleNodesChange` above.
      const primary = selectedWaypoints.size > 0 ? draggedNodes[0] : undefined;
      if (primary) {
        const persisted = primary.data.container
          ? getContainer(sfmDoc, primary.id)
          : getNode(sfmDoc, primary.id);
        if (persisted) {
          const dx = primary.position.x - persisted.x;
          const dy = primary.position.y - persisted.y;
          if (dx !== 0 || dy !== 0) {
            // Ids of every node ALSO being dragged in this same gesture —
            // needed below to avoid double-shifting a waypoint whose edge's
            // both endpoints are in this set: `onNodeDragStop` (called at
            // the end of this function) has its OWN "rigid pair" logic that
            // already rides those waypoints along by the identical delta,
            // so this loop skips them rather than applying the same shift
            // twice.
            const draggedNodeIds = new Set(draggedNodes.map((n) => n.id));
            for (const key of selectedWaypoints) {
              const parsed = parseWaypointKey(key);
              if (!parsed) continue;
              const edgeRecord = getEdge(sfmDoc, parsed.edgeId);
              if (!edgeRecord) continue;
              if (draggedNodeIds.has(edgeRecord.fromNode) && draggedNodeIds.has(edgeRecord.toNode)) {
                continue;
              }
              const waypoint = edgeRecord.waypoints[parsed.index];
              if (!waypoint) continue;
              updateWaypoint(sfmDoc, parsed.edgeId, parsed.index, {
                x: waypoint.x + dx,
                y: waypoint.y + dy,
              });
            }
          }
        }
        setWaypointGroupDragDelta(null);
      }

      onNodeDragStop(event, node, draggedNodes);
    },
    [onNodeDragStop, dragPublisher, selectedWaypoints, sfmDoc, setWaypointGroupDragDelta],
  );

  // The other half of live drag broadcasting: every *other* peer's
  // currently-dragging nodes, scoped to `containerId` exactly like
  // `PresenceCursors.tsx`'s cursor visibility (a drag inside an outpost
  // nobody else is viewing shouldn't render for them). Rendered by
  // overriding the affected node's position (and giving it a colored
  // outline in the dragger's own presence color) in the array actually
  // handed to `<ReactFlow>` — `nodes` itself stays the untouched,
  // doc-derived list everything else in this component (selection,
  // marquee, keybinds, the node context menu) keeps reading, so a remote
  // drag overlay can never leak into a local selection/edit operation.
  const remotePresence = useRemotePresence(awareness);
  // Bridges the gap between "a peer's drag ended" (Awareness — arrives the
  // instant `dragPublisher.clear()` fires) and "the node's real position
  // actually landed in the doc" (`moveNode`'s Yjs update — a separate
  // message on a separate channel, with no ordering guarantee relative to
  // the first). Without this, the moment `dragging` clears, this override
  // stops and rendering falls through to `nodes`' own (possibly not-yet-
  // updated) position — for a small/slow drag that's an imperceptible
  // sub-frame flicker, but for a fast, long drag the pre-drag position can
  // be far enough away (off-screen, behind another node) to read as the
  // node — and, since its edges follow it, the connection too —
  // momentarily vanishing. `DRAG_RELEASE_GRACE_MS` holds the last live
  // position a little past `dragging` clearing, giving the doc update time
  // to actually land before this stops overriding; `remotePresence` itself
  // already re-evaluates at least every `useRemotePresence.ts`'s
  // `STALE_CHECK_INTERVAL_MS` (150ms) even with no genuine change, which is
  // what lets a held entry's expiry actually get noticed without a
  // dedicated timer here.
  const heldDraggingRef = useRef<Map<string, { value: { x: number; y: number; color: string; displayName: string }; expiresAt: number }>>(
    new Map(),
  );
  const remoteDraggingByNodeId = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, { x: number; y: number; color: string; displayName: string }>();
    for (const { state } of remotePresence) {
      if (!isDraggingVisibleInContainer(state.dragging, containerId)) continue;
      for (const dragged of state.dragging!.nodes) {
        map.set(dragged.id, {
          x: dragged.x,
          y: dragged.y,
          color: state.color,
          displayName: state.displayName,
        });
      }
    }
    const held = heldDraggingRef.current;
    for (const [id, value] of map) {
      held.set(id, { value, expiresAt: now + DRAG_RELEASE_GRACE_MS });
    }
    for (const [id, entry] of held) {
      if (map.has(id)) continue;
      if (now < entry.expiresAt) {
        map.set(id, entry.value);
      } else {
        held.delete(id);
      }
    }
    return map;
  }, [remotePresence, containerId]);
  // A dragged node's position only arrives every ~50ms
  // (`useDragPublisher.ts`'s `DRAG_PUBLISH_INTERVAL_MS`) — rendering
  // `remote.x`/`.y` straight from `remoteDraggingByNodeId` would make it
  // visibly hop between samples instead of gliding, same reasoning as
  // `PresenceCursors.tsx`'s identical use of `useSmoothedPositions`.
  const remoteDraggingTargets = useMemo(() => {
    const map = new Map<string, Point>();
    for (const [id, remote] of remoteDraggingByNodeId) map.set(id, { x: remote.x, y: remote.y });
    return map;
  }, [remoteDraggingByNodeId]);
  const smoothedRemoteDragging = useSmoothedPositions(remoteDraggingTargets);
  const renderedNodes = useMemo(() => {
    // Public-link work: `readOnly` needs injecting into EVERY node's data
    // (not just remotely-dragged ones), same "fold it into the bail-out and
    // the per-node skip" shape as `renderedEdges`' identical change above.
    if (remoteDraggingByNodeId.size === 0 && !readOnly) return nodes;
    return nodes.map((node) => {
      const remote = remoteDraggingByNodeId.get(node.id);
      if (!remote || draggingPositionsRef.current.has(node.id)) {
        return readOnly ? { ...node, data: { ...node.data, readOnly } } : node;
      }
      const position = smoothedRemoteDragging.get(node.id) ?? { x: remote.x, y: remote.y };
      // The doc's own (persisted) position has already caught up to within
      // a pixel of the live/held remote one — the real `moveNode` commit
      // has landed, so there's no gap left to bridge. Releases the grace
      // hold immediately rather than waiting out the rest of
      // `DRAG_RELEASE_GRACE_MS` (see `remoteDraggingByNodeId`'s doc comment)
      // for no reason once the truth has already arrived.
      if (Math.abs(node.position.x - position.x) < 1 && Math.abs(node.position.y - position.y) < 1) {
        heldDraggingRef.current.delete(node.id);
        return readOnly ? { ...node, data: { ...node.data, readOnly } } : node;
      }
      return {
        ...node,
        data: { ...node.data, readOnly },
        position,
        style: {
          ...node.style,
          outline: `2px solid ${remote.color}`,
          outlineOffset: 2,
          borderRadius: 8,
        },
      };
    });
    // `draggingPositionsRef` is a ref (mutated inside `handleNodesChange`,
    // read here without being a dependency) — safe because every local drag
    // frame that touches it also changes `nodes` itself (`onNodesChange` →
    // `applyNodeChanges` → the store), which re-triggers this memo anyway.
  }, [nodes, remoteDraggingByNodeId, smoothedRemoteDragging, readOnly]);

  // The connection/waypoint sibling of the node-drag overlay above: every
  // *other* peer's currently-dragging waypoint or connection label
  // (`ConnectionEdge.tsx`'s own `dragIndex`/`dragPoint`/`labelDragIndex`/
  // `labelDragPoint` local state, broadcast via `useEdgeDragPublisher.ts`),
  // scoped to `containerId` the same way. Reuses `remotePresence` (already
  // subscribed above for node dragging) rather than a second
  // `useRemotePresence` call. Threaded onto the relevant edge's own `data`
  // (`remoteWaypointDrag`) instead of a separate context, mirroring how
  // `record`/`projected` already ride along on every edge — `ConnectionEdge`
  // reads it exactly like its own local drag state.
  const heldEdgeDraggingRef = useRef<
    Map<
      string,
      {
        value: { mode: "move" | "insert"; waypointIndex: number; x: number; y: number; color: string; displayName: string };
        expiresAt: number;
      }
    >
  >(new Map());
  const remoteEdgeDraggingByEdgeId = useMemo(() => {
    const now = Date.now();
    const map = new Map<
      string,
      {
        mode: "move" | "insert";
        waypointIndex: number;
        x: number;
        y: number;
        color: string;
        displayName: string;
      }
    >();
    for (const { state } of remotePresence) {
      if (!isEdgeDraggingVisibleInContainer(state.edgeDragging, containerId)) continue;
      const { edgeId, mode, waypointIndex, x, y } = state.edgeDragging!;
      map.set(edgeId, {
        mode,
        waypointIndex,
        x,
        y,
        color: state.color,
        displayName: state.displayName,
      });
    }
    // Same bridging-the-gap reasoning as `remoteDraggingByNodeId` above —
    // this edge/waypoint's real `updateWaypoint`/`addWaypoint` commit can
    // land slightly after `edgeDragging` clears, and a fast label/waypoint
    // drag makes that gap's stale-position revert visible.
    const held = heldEdgeDraggingRef.current;
    for (const [id, value] of map) {
      held.set(id, { value, expiresAt: now + DRAG_RELEASE_GRACE_MS });
    }
    for (const [id, entry] of held) {
      if (map.has(id)) continue;
      if (now < entry.expiresAt) {
        map.set(id, entry.value);
      } else {
        held.delete(id);
      }
    }
    return map;
  }, [remotePresence, containerId]);
  // Same "raw sample vs. glide" tradeoff as the node-drag overlay above —
  // a dragged waypoint/label only publishes every ~50ms too
  // (`useEdgeDragPublisher.ts`'s `EDGE_DRAG_PUBLISH_INTERVAL_MS`).
  const remoteEdgeDraggingTargets = useMemo(() => {
    const map = new Map<string, Point>();
    for (const [edgeId, remote] of remoteEdgeDraggingByEdgeId) map.set(edgeId, { x: remote.x, y: remote.y });
    return map;
  }, [remoteEdgeDraggingByEdgeId]);
  const smoothedRemoteEdgeDragging = useSmoothedPositions(remoteEdgeDraggingTargets);
  // The group-drag sibling of the map above: every waypoint a REMOTE peer's
  // node-driven GROUP drag (their own marquee selection — pure per-client
  // UI state, never synced) is carrying along, keyed by edge id then
  // waypoint index — see `useYjsSync.ts`'s `CanvasEdgeData.remoteGroupWaypoints`
  // doc comment for why this can't just be read off `selectedWaypoints`
  // locally the way this client's OWN group drag is.
  const remoteGroupWaypointsByEdgeId = useMemo(() => {
    const map = new Map<string, Map<number, { x: number; y: number; color: string; displayName: string }>>();
    for (const { state } of remotePresence) {
      if (!isDraggingVisibleInContainer(state.dragging, containerId)) continue;
      for (const wp of state.dragging!.waypoints) {
        let byIndex = map.get(wp.edgeId);
        if (!byIndex) {
          byIndex = new Map();
          map.set(wp.edgeId, byIndex);
        }
        byIndex.set(wp.index, { x: wp.x, y: wp.y, color: state.color, displayName: state.displayName });
      }
    }
    return map;
  }, [remotePresence, containerId]);
  // Rides the same `${edgeId}:${index}` composite key through smoothing —
  // a flat map is all `useSmoothedPositions` needs to key on, the nested
  // per-edge shape only matters once it's handed to `ConnectionEdge`.
  const remoteGroupWaypointTargets = useMemo(() => {
    const map = new Map<string, Point>();
    for (const [edgeId, byIndex] of remoteGroupWaypointsByEdgeId) {
      for (const [index, wp] of byIndex) map.set(`${edgeId}:${index}`, { x: wp.x, y: wp.y });
    }
    return map;
  }, [remoteGroupWaypointsByEdgeId]);
  const smoothedRemoteGroupWaypoints = useSmoothedPositions(remoteGroupWaypointTargets);
  const renderedEdges = useMemo(() => {
    // Public-link work: `readOnly` needs injecting into EVERY edge's data
    // (not just ones with remote drag activity), so the early bail-out and
    // the per-edge skip below both fold it into their condition rather than
    // only firing for the pre-existing remote-drag cases.
    if (remoteEdgeDraggingByEdgeId.size === 0 && remoteGroupWaypointsByEdgeId.size === 0 && !readOnly) {
      return edges;
    }
    return edges.map((edge) => {
      const remoteWaypointDragRaw = remoteEdgeDraggingByEdgeId.get(edge.id);
      const remoteWaypointDrag = remoteWaypointDragRaw
        ? { ...remoteWaypointDragRaw, ...(smoothedRemoteEdgeDragging.get(edge.id) ?? remoteWaypointDragRaw) }
        : undefined;
      const remoteGroupWaypointsRaw = remoteGroupWaypointsByEdgeId.get(edge.id);
      const remoteGroupWaypoints = remoteGroupWaypointsRaw
        ? new Map(
            Array.from(remoteGroupWaypointsRaw, ([index, wp]) => [
              index,
              { ...wp, ...(smoothedRemoteGroupWaypoints.get(`${edge.id}:${index}`) ?? wp) },
            ]),
          )
        : undefined;
      const record = edge.data?.record;
      if ((!remoteWaypointDrag && !remoteGroupWaypoints && !readOnly) || !record) return edge;
      // `record` explicit (not just spread from `edge.data`) so this stays
      // typed as a real `CanvasEdgeData` — `edge.data` is optional on React
      // Flow's own base edge type, which would otherwise widen `record` to
      // possibly-`undefined` here even though the guard above already
      // ensures it exists.
      const data: CanvasEdgeData = { ...edge.data, record, remoteWaypointDrag, remoteGroupWaypoints, readOnly };
      return { ...edge, data };
    });
  }, [
    edges,
    remoteEdgeDraggingByEdgeId,
    remoteGroupWaypointsByEdgeId,
    smoothedRemoteEdgeDragging,
    smoothedRemoteGroupWaypoints,
    readOnly,
  ]);

  // Job 013: right-click-on-a-node menu state — "move to container" for a
  // real node, "open"/"delete (reparent, don't destroy)" for an outpost
  // boundary node. See `outposts/NodeContextMenu.tsx`.
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenuState | null>(null);
  // Outpost I/O rework: pending "Delete Outpost" confirmation — the
  // right-click menu item now opens this dialog instead of deleting
  // immediately (`DeleteOutpostDialog.tsx`).
  const [deleteRequest, setDeleteRequest] = useState<{ id: string; kind: "outpost" } | null>(null);
  // Not React state on purpose — a click-time bookkeeping ref, not something whose change should trigger a render.
  const lastPaneClickRef = useRef<ClickPoint | null>(null);

  // Job 012 (paste-centering follow-up): the `<ReactFlow>` pane's own wrapper
  // div, measured on demand by `getPasteCenter` below — not React state,
  // since nothing needs to re-render when it mounts, only read its (already
  // up to date) bounding rect at paste time.
  const paneWrapperRef = useRef<HTMLDivElement>(null);
  /**
   * Where a paste centers the pasted group — the visible canvas area's
   * center (this wrapper fills it exactly; toolbar/panels float on top of
   * it, they don't shrink it), converted to document/flow coordinates.
   * `null` before the wrapper's first layout, which `pasteOffsetForCenter`
   * treats as "fall back to the old fixed offset."
   */
  const getPasteCenter = useCallback((): { x: number; y: number } | null => {
    const rect = paneWrapperRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [screenToFlowPosition]);

  // Job 011: drag-to-connect, edge removal via re-drag, and mismatched-part
  // rejection. See `useConnectionHandlers.ts`'s header comment for exactly
  // how the reconnect-vs-remove-by-drag split works.
  const {
    isValidConnection,
    onConnect,
    onReconnectStart,
    onReconnect,
    onReconnectEnd,
    isReconnecting,
  } = useConnectionHandlers(sfmDoc, containerId);

  // Job 012: right-click-drag marquee multi-select. `enabled` also gates
  // off the Job 013 node context menu, mirroring the existing Recipe
  // Chooser gate, so a marquee can't start underneath either overlay.
  const { overlayRect, pointerHandlers, consumeJustDragged } = useMarqueeSelection({
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    setSelectedWaypoints,
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
    // Public-link work: disables cut/copy/paste/delete/undo/redo keybinds
    // outright for a read-only public viewer — every one of them mutates
    // the doc (or, for undo/redo, only makes sense given real local edit
    // history to revert).
    enabled: !readOnly && chooser === null && nodeMenu === null,
    getPasteCenter,
  });

  function openChooserAt(
    clientX: number,
    clientY: number,
    pendingConnection?: PendingConnectionInfo,
  ) {
    // Public-link work: every call site (double-click, right-click, and a
    // connection dragged out to empty canvas) funnels through here — a
    // single guard covers all three "add a node" entry points at once.
    if (readOnly) return;
    setChooser({
      flowPosition: screenToFlowPosition({ x: clientX, y: clientY }),
      screenPosition: { x: clientX, y: clientY },
      pendingConnection,
    });
  }

  /**
   * A connection dragged out from a port handle and released — fires for
   * EVERY drag-to-connect gesture, successful or not (React Flow's
   * `onConnectEnd` contract), including a reconnect drag of an existing
   * edge's endpoint (see `isReconnecting`'s own doc comment for why that
   * case is explicitly excluded here — Job 011's own "remove by re-dragging
   * elsewhere" already owns it via `onReconnectEnd`). Opens the Recipe
   * Chooser, pre-filtered to the dragged-from port's complementary parts
   * (`RecipeChooser`'s `pendingConnection` prop), only when the drag ended
   * on empty canvas (`connectionState.toHandle` is `null` — a successful
   * drop onto a real handle already went through `onConnect` above).
   *
   * A Storage Container's own `Handle`s are permanent wildcards (see
   * `storageNodePart`'s doc comment for why they can never be renamed to a
   * real part after the fact), so `portInfo.part` alone would be `"*"` for
   * one — substituted here with whatever item it's actually already holding,
   * so dragging from its output pre-filters the chooser exactly like
   * dragging from a real recipe port does, instead of falling back to
   * "unfiltered."
   */
  const handleConnectEnd = (
    event: MouseEvent | TouchEvent,
    connectionState: FinalConnectionState,
  ) => {
    if (isReconnecting()) return;
    if (connectionState.toHandle || !connectionState.fromHandle || !connectionState.fromNode)
      return;
    const portInfo = parsePortHandleId(connectionState.fromHandle.id);
    if (!portInfo) return;
    const point = eventClientPoint(event);
    const fromNodeRecord = getNode(sfmDoc, connectionState.fromHandle.nodeId);
    const part =
      fromNodeRecord?.kind === "storage"
        ? (storageNodePart(sfmDoc, connectionState.fromHandle.nodeId) ?? portInfo.part)
        : portInfo.part;
    openChooserAt(point.x, point.y, {
      nodeId: connectionState.fromHandle.nodeId,
      handleId: connectionState.fromHandle.id ?? "",
      direction: portInfo.direction,
      part,
    });
  };

  // `onPaneClick` only fires for clicks that land on the empty background
  // (React Flow doesn't call it for clicks on a node), so this already
  // satisfies "double-click the *empty* canvas" without extra checks.
  const handlePaneClick = (event: ReactMouseEvent) => {
    // Clicking away deselects everything React Flow itself already
    // deselects (nodes/edges, via its own default click-on-pane behavior)
    // — waypoints need the same treatment done explicitly, since they're
    // not a first-class flow element React Flow manages selection for.
    if (selectedWaypoints.size > 0) setSelectedWaypoints(new Set());
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
    // Public-link work: the menu itself is all mutation (move to container,
    // delete/convert an outpost, quick-settings edits) — suppress opening it
    // entirely rather than rendering a menu whose every action would be a
    // no-op.
    if (readOnly) return;
    setNodeMenu({
      nodeId: node.id,
      containerKind: node.data.container ? "outpost" : null,
      container: node.data.container ?? undefined,
      // Right-clicking a node whose kind has quick settings (a real
      // `"recipe"` node's clock/auto-round/somersloops, or just the Name
      // field every other real node kind still gets — see
      // `RecipeNodeQuickSettings.tsx`'s own `hasMachineFields` guard)
      // surfaces them in the same menu, below the move-to-container actions
      // above.
      recipeRecord:
        node.data.record && QUICK_SETTINGS_KINDS.has(node.data.record.kind)
          ? node.data.record
          : undefined,
      locked: node.data.record ? LOCKED_NODE_KINDS.has(node.data.record.kind) : false,
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

  // `nodeMenu.recipeRecord` is a one-time snapshot taken at right-click time
  // (`handleNodeContextMenu` below) and never updates again on its own — so
  // the quick settings section re-derives the *live* record from `nodes`
  // (which does update reactively via `sync`) on every render instead of
  // trusting the stale copy sitting in `nodeMenu` state. Without this, the
  // clock/auto-round/somersloop controls would keep showing whatever the
  // record looked like at the moment the menu opened even though the
  // underlying node (and its own card) had since moved on.
  const liveNodeMenuRecord = nodeMenu
    ? nodes.find((node) => node.id === nodeMenu.nodeId)?.data.record
    : undefined;
  // Same "live, not the right-click-time snapshot" treatment for the
  // rename field's `container` — otherwise it'd keep showing whatever the
  // title was at the moment the menu opened even after a remote peer (or
  // this client's own commit) changed it.
  const liveNodeMenuContainer = nodeMenu
    ? sync.containers.find((container) => container.id === nodeMenu.nodeId)
    : undefined;
  const nodeMenuState = nodeMenu && {
    ...nodeMenu,
    container: liveNodeMenuContainer,
    recipeRecord:
      liveNodeMenuRecord && QUICK_SETTINGS_KINDS.has(liveNodeMenuRecord.kind)
        ? liveNodeMenuRecord
        : undefined,
  };

  // Both the marquee (Job 012) and live cursor publishing (Job 021) need
  // `onPointerMove` on the same wrapper div below — a plain `{...pointerHandlers}`
  // spread followed by `onPointerMove={cursorHandlers.onPointerMove}` would
  // silently clobber one with the other (JSX props are just object keys),
  // so this merges them into one handler instead of spreading.
  function handleWrapperPointerMove(event: ReactPointerEvent) {
    pointerHandlers.onPointerMove(event);
    cursorHandlers.onPointerMove(event);
  }

  return (
    // Job 012: the marquee's own pointer handlers live on this wrapper
    // (not passed as extra props into `<ReactFlow>`) so a right-click-drag
    // starting anywhere over the canvas — including on top of a node, not
    // just the empty pane — is caught, and so the overlay rect below can
    // sit as a plain sibling of `<ReactFlow>` without reaching into its
    // internals.
    <div
      ref={paneWrapperRef}
      className="relative h-full w-full"
      onPointerDown={pointerHandlers.onPointerDown}
      onPointerMove={handleWrapperPointerMove}
      onPointerUp={pointerHandlers.onPointerUp}
      onPointerCancel={pointerHandlers.onPointerCancel}
      onPointerLeave={cursorHandlers.onPointerLeave}
    >
      <ReactFlow
        nodes={renderedNodes}
        edges={renderedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        onConnect={onConnect}
        onConnectEnd={handleConnectEnd}
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
        nodesDraggable={editingEnabled}
        nodesConnectable={editingEnabled}
        elementsSelectable={interactive}
      >
        {/*
          Job 014: the dot grid's spacing mirrors `Settings.gridMachine`
          (the same field `useYjsSync.ts`'s `onNodeDragStop` snaps *to*) —
          two independent mechanisms (rendering a grid vs. actually snapping
          to it) kept visually consistent per this job's own scope note,
          rather than one implying the other: every dot is a real snap
          point, 1:1, so `DEFAULT_SETTINGS.gridMachine` (see `document.ts`)
          is the actual density knob, not this gap. `color` is a real CSS
          custom property reference (`var(--grid-dot)`), not a literal —
          `Background` forwards its `color` prop into the SVG's own `style`
          attribute as `--xy-background-pattern-color-props` (confirmed
          against `@xyflow/react`'s source), so this resolves through
          `index.css`'s theme tokens exactly like any other themed value in
          this app, swapping automatically between light/dark with no JS
          branching needed here.
        */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={[settings.gridMachine.x, settings.gridMachine.y]}
          size={3}
          color="var(--grid-dot)"
        />
        <Controls
          showZoom={false}
          showFitView={false}
          showInteractive={false}
          // The pinned summary sidebar (`SummaryPanel.tsx`) docks fixed over
          // this canvas's left edge, at `SUMMARY_SIDEBAR_WIDTH_PX` wide —
          // without this, it sits on top of these zoom/fit/lock buttons
          // (React Flow's own default bottom-left `<Controls>` position,
          // 15px margin). Shifting `left` by the sidebar's width plus that
          // same 15px margin clears it exactly.
          style={summaryPinned ? { left: SUMMARY_SIDEBAR_WIDTH_PX + 15 } : undefined}
        >
          <ControlButton
            onClick={() => zoomIn()}
            title={t("canvas.zoomIn")}
            aria-label={t("canvas.zoomIn")}
          >
            <ZoomIn aria-hidden style={controlButtonIconStyle} />
          </ControlButton>
          <ControlButton
            onClick={() => zoomOut()}
            title={t("canvas.zoomOut")}
            aria-label={t("canvas.zoomOut")}
          >
            <ZoomOut aria-hidden style={controlButtonIconStyle} />
          </ControlButton>
          <ControlButton
            onClick={() => fitView()}
            title={t("canvas.fitView")}
            aria-label={t("canvas.fitView")}
          >
            <Maximize aria-hidden style={controlButtonIconStyle} />
          </ControlButton>
          {/* Public-link work: hidden outright for a read-only public viewer — there's nothing to unlock, `editingEnabled` above can never become `true` regardless of this toggle. */}
          {!readOnly && (
            <ControlButton
              onClick={() => setInteractive((v) => !v)}
              title={interactive ? t("canvas.lockInteraction") : t("canvas.unlockInteraction")}
              aria-label={interactive ? t("canvas.lockInteraction") : t("canvas.unlockInteraction")}
            >
              {interactive ? (
                <Unlock aria-hidden style={controlButtonIconStyle} />
              ) : (
                <Lock aria-hidden style={controlButtonIconStyle} />
              )}
            </ControlButton>
          )}
        </Controls>
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
      </ReactFlow>
      {/* Job 021: other collaborators' live cursors, container-scoped to `containerId` — see `PresenceCursors.tsx`'s header comment for the coordinate-space handling. A plain sibling of `<ReactFlow>` (not a child), same layering approach as `MarqueeOverlay`/`RecipeChooser` below. */}
      <PresenceCursors awareness={awareness} containerId={containerId} />
      {chooser && (
        <RecipeChooser
          flowPosition={chooser.flowPosition}
          screenPosition={chooser.screenPosition}
          pendingConnection={chooser.pendingConnection}
          onClose={() => setChooser(null)}
        />
      )}
      {overlayRect && <MarqueeOverlay rect={overlayRect} />}
      {nodeMenuState && (
        <NodeContextMenu
          state={nodeMenuState}
          siblingOutposts={siblingOutposts}
          parentContainer={parentContainer}
          onMoveToContainer={(nodeId, targetContainerId) =>
            moveNodeToContainer(sfmDoc, nodeId, targetContainerId)
          }
          onOpenOutpost={(id) => navigateToContainer(id)}
          onRequestDelete={(id, kind) => setDeleteRequest({ id, kind })}
          numberFormats={settings.numberFormats}
          onClose={() => setNodeMenu(null)}
        />
      )}
      {deleteRequest && (
        <DeleteOutpostDialog
          open
          containerKind={deleteRequest.kind}
          containerTitle={sync.containers.find((container) => container.id === deleteRequest.id)?.title ?? ""}
          onCancel={() => setDeleteRequest(null)}
          onKeepContents={() => {
            deleteOutpost(sfmDoc, deleteRequest.id);
            setDeleteRequest(null);
          }}
          onDeleteEverything={() => {
            deleteOutpostWithContents(sfmDoc, deleteRequest.id);
            setDeleteRequest(null);
          }}
        />
      )}
    </div>
  );
}
