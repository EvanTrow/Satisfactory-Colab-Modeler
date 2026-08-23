// The Zustand store + Yjs observer wiring that keeps React Flow's node/edge
// arrays in sync with a `@scm/ydoc` `SfmDocument` (per PLAN.md §7's "State"
// row: "Zustand for ephemeral UI state only — the document lives in Yjs").
//
// Data flow, precisely (see jobs/008-canvas-skeleton.md's Handoff notes for
// the full write-up):
//
//   Yjs doc (source of truth)
//     --observeDeep--> full re-read via listNodes/listEdges/listContainers
//     --> Zustand store.setState
//     --> React Flow re-renders from the store's `nodes`/`edges` arrays
//
//   React Flow drag gesture
//     --onNodesChange (per-frame)--> applied *locally* to the Zustand store
//         via `applyNodeChanges` for smooth 60fps dragging; the Yjs doc is
//         NOT touched on every frame.
//     --onNodeDragStop (once, at drag end)--> `moveNode(sfmDoc, id, x, y)`
//         (a real recipe node) or `updateContainer(sfmDoc, id, {x, y})` (an
//         outpost boundary node, Job 013) --> Yjs doc updates --> the
//         observer above fires --> the store's optimistic local position is
//         overwritten by the (identical) persisted value.
//
// So the Zustand store is a *derived cache* of the Yjs doc, not an
// independent source of truth — with one deliberate, temporary exception:
// while a drag is in flight, the store's node position is ahead of the doc
// (that's what makes dragging feel smooth instead of round-tripping through
// a full Yjs resync on every mouse-move). Every write that's meant to
// persist goes through `@scm/ydoc`'s `mutations.ts` helpers — this file
// never constructs or mutates a `Y.Map`/`Y.Array` directly.
//
// Job 013 (outposts) rewired this hook's "what does `nodes`/`edges` even
// contain" answer: it used to be *the whole document* (every node/edge/
// container regardless of nesting). It's now scoped to a single
// `containerId` — "the container currently being viewed" — per PLAN.md §2's
// "from outside, the outpost is a single node... from inside, drill in to
// edit contents". Three things happen on every resync now, not one:
//   1. Real nodes/edges directly inside `containerId` render exactly as
//      before (Jobs 008-012's behavior, unchanged for the common case).
//   2. Every *child* container of `containerId` (an outpost one level down)
//      renders as a single synthetic "outpost" node, with a derived port
//      list (`outposts/portMapping.ts`'s `computeOutpostPorts` — computed
//      fresh every resync, never stored).
//   3. Edges that cross a container boundary are *projected* onto those
//      synthetic nodes (`outposts/visibleGraph.ts`'s `computeVisibleEdges`)
//      instead of reaching into a container that isn't currently rendered.
import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import {
  type Container,
  type EdgeRecord,
  type NodeRecord,
  type SfmDocument,
  getContainer,
  getNode,
  getSettings,
  listContainers,
  listEdges,
  listNodes,
  moveNode,
  updateContainer,
  updateWaypoint,
} from "@scm/ydoc";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Edge as RFEdge,
  type EdgeChange,
  type Node as RFNode,
  type NodeChange,
  type OnEdgesChange,
  type OnNodeDrag,
  type OnNodesChange,
} from "@xyflow/react";

import type { RecipeNodeValidityState } from "./nodes/validityState";
import { ensureOutpostIoNodes } from "./outposts/io";
import { type DerivedOutpostPort, buildContainerParentMap, computeOutpostPorts } from "./outposts/portMapping";
import { type ProjectedEdge, computeVisibleEdges } from "./outposts/visibleGraph";
import { snapPointToGrid } from "./snapToGrid";

/**
 * The full `NodeRecord` rides along in `data` for whichever job needs it —
 * `RecipeNode.tsx` (Job 010) is the first real consumer, reading
 * `data.record` directly rather than re-fetching from the doc on every
 * render. `label` remains for React Flow's built-in "default" node type,
 * still used for any `kind` Job 010 doesn't own a custom renderer for (e.g.
 * `kind: "debug"` from `DevNodeTools`, or the not-yet-built splurger/
 * storage kinds).
 */
export interface CanvasNodeData extends Record<string, unknown> {
  /** Present for every real, `@scm/ydoc`-node-backed flow node (`type: "recipe"` and friends). Absent for a Job 013 synthetic outpost boundary node. */
  record?: NodeRecord;
  /** Present only for a synthetic outpost boundary node (`type: "outpost"`) — the `Container` record this node stands in for. */
  container?: Container;
  /** Present only for a synthetic outpost boundary node — its derived port list (`outposts/portMapping.ts`), recomputed fresh every resync and never persisted. */
  ports?: DerivedOutpostPort[];
  label: string;
  /**
   * Job 019's red/orange validity-highlighting slot — see
   * `./nodes/validityState.ts`'s header comment for the full contract.
   * Always `null` as of this job; `RecipeNode.tsx` accepts it but doesn't
   * yet render anything different for a non-null value.
   */
  validityState?: RecipeNodeValidityState | null;
  /**
   * Public-link work: `true` for a read-only public viewer
   * (`CanvasView.tsx`'s `CanvasFlow`, set unconditionally on every node
   * while its own `readOnly` prop is on). Every custom node component
   * (`RecipeNode`/`SinkNode`/`StorageNode`/`SplurgerNode`) has its own
   * always-visible input/button controls (the limit field, the storage
   * mode dropdown, a Splurger connection's disconnect/flip-tier buttons, a
   * recipe's own per-port drag-reorder/right-click-remove) that mutate the
   * doc directly, entirely
   * independent of React Flow's `nodesDraggable`/`elementsSelectable` props
   * — this is the signal each of them reads to disable those controls
   * outright rather than relying on the server to silently drop the write.
   */
  readOnly?: boolean;
}

export type CanvasNode = RFNode<CanvasNodeData>;

/**
 * The full `EdgeRecord` rides along in `data` (ground truth — endpoints,
 * waypoints, `part`, `labelPos` — even for a boundary-projected edge, whose
 * *rendered* top-level `source`/`target`/`sourceHandle`/`targetHandle`
 * below may differ from this record's own `fromNode`/`toNode`/`fromPort`/
 * `toPort`; see `outposts/visibleGraph.ts`). `ConnectionEdge.tsx` (Job 011)
 * reads `data.record` rather than re-fetching from the doc on every render.
 */
export interface CanvasEdgeData extends Record<string, unknown> {
  record: EdgeRecord;
  /**
   * True when this edge's rendered endpoints were redirected to an
   * outpost's boundary node (Job 013) — i.e. this isn't the edge's own
   * literal `fromNode`/`toNode`. `ConnectionEdge.tsx` reads this purely for
   * its boundary-crossing visual treatment (dashed amber stroke, tooltip
   * wording) — every gesture (drag/add/remove a waypoint, delete the
   * connection) works the same regardless, since an edge (boundary or not)
   * only ever renders in the single view where both its endpoints resolve
   * together (`outposts/visibleGraph.ts`), so `record.waypoints` are always
   * meaningful in *that* view's coordinate space.
   */
  projected?: boolean;
  /**
   * Live drag broadcasting: set only while a remote peer is actively
   * dragging this edge's bare label or one of its waypoints
   * (`CanvasView.tsx`'s `CanvasFlow`, sourced from that peer's Awareness
   * `edgeDragging` field — see `collab/awareness.ts`'s `AwarenessEdgeDragging`).
   * `ConnectionEdge.tsx` renders this exactly like its own local
   * `dragIndex`/`dragPoint`/`labelDragIndex`/`labelDragPoint` optimistic drag
   * state, just sourced from a peer instead of this client's own pointer.
   */
  remoteWaypointDrag?: { mode: "move" | "insert"; waypointIndex: number; x: number; y: number; color: string; displayName: string };
  /**
   * Live drag broadcasting: for THIS edge, every waypoint index a REMOTE
   * peer's node-driven GROUP drag is currently carrying along — sourced
   * from that peer's Awareness `dragging.waypoints` (see
   * `collab/awareness.ts`'s `AwarenessDraggingWaypoint`), since
   * `GroupSelectionContext.ts`'s `selectedWaypoints` is pure per-client UI
   * state that's never synced — a viewer has no other way to learn "these
   * specific indices are moving" for a group drag someone ELSE started.
   * Keyed by waypoint index rather than a single delta (unlike this
   * client's own local `waypointGroupDragDelta`) because, in principle,
   * more than one remote peer's independent, non-rigid drag could be
   * moving different waypoints on the same edge at once.
   * `ConnectionEdge.tsx` applies each position exactly like its own local
   * group-drag preview, just per-index absolute positions instead of one
   * shared delta.
   */
  remoteGroupWaypoints?: Map<number, { x: number; y: number; color: string; displayName: string }>;
  /**
   * Public-link work: `true` for a read-only public viewer
   * (`CanvasView.tsx`'s `CanvasFlow`, set unconditionally on every edge
   * while its own `readOnly` prop is on). `ConnectionEdge.tsx`'s waypoint/
   * label gestures (create/move/delete a waypoint, delete the connection)
   * are all handled by that component's own pointer/click handlers rather
   * than React Flow's `nodesDraggable`/`elementsSelectable` props, so they
   * need this explicit signal rather than inheriting one from `<ReactFlow>`.
   */
  readOnly?: boolean;
}

export type CanvasEdge = RFEdge<CanvasEdgeData>;

const CUSTOM_NODE_KINDS = new Set([
  "recipe",
  "splurger",
  "sink",
  "depot",
  "storage",
  "outpost-input",
  "outpost-output",
]);

function nodeRecordToFlowNode(record: NodeRecord, selected = false): CanvasNode {
  return {
    // `kind: "recipe"` (`RecipeNode`), `kind: "splurger"` (`SplurgerNode`,
    // Job 024), `kind: "sink"`/`"depot"` (`SinkNode`) and `kind: "storage"`
    // (`StorageNode`) all have a real custom node type, registered in
    // `CanvasView.tsx`'s `nodeTypes` under their own kind string. Every
    // other kind (the `"debug"` kind `DevNodeTools` uses, or anything
    // unrecognized) falls back to React Flow's built-in "default" box, same
    // as every kind did before Job 010.
    id: record.id,
    type: CUSTOM_NODE_KINDS.has(record.kind) ? record.kind : "default",
    position: { x: record.x, y: record.y },
    // Job 012: `selected` is carried over from whatever the store's
    // previous copy of this node had (see `syncAll` below) — this
    // function itself has no notion of "current" selection, it just accepts
    // whatever the caller already determined.
    selected,
    data: { record, label: record.title || record.kind || record.id, validityState: null },
  };
}

/**
 * Job 013: an outpost, viewed from its *parent* container, renders as a
 * single synthetic node — `type: "outpost"` (`OutpostNode.tsx`) — instead
 * of its own contents. Its on-canvas position comes straight from the
 * `Container` record's own `x`/`y` (Job 007's schema already carries these,
 * unused until now), and `onNodeDragStop` below writes back to the same
 * pair via `updateContainer`, mirroring how a real node's position is
 * `NodeRecord.x`/`.y` via `moveNode`.
 */
function containerToOutpostFlowNode(container: Container, ports: DerivedOutpostPort[], selected = false): CanvasNode {
  return {
    id: container.id,
    type: "outpost",
    position: { x: container.x, y: container.y },
    selected,
    data: { container, ports, label: container.title || "Outpost" },
  };
}

/** Converts a `ProjectedEdge` (`outposts/visibleGraph.ts`) into the flow edge shape — `type: "boundary"` for a projected (boundary-crossing) edge vs. `type: "part"` for a normal direct one, purely so `ConnectionEdge.tsx` (both map to it, `flowTypes.ts`) knows which visual treatment to use; `data.projected` carries the same distinction through to that component. */
function projectedEdgeToFlowEdge(projected: ProjectedEdge, selected = false): CanvasEdge {
  return {
    id: projected.record.id,
    type: projected.projected ? "boundary" : "part",
    source: projected.source,
    sourceHandle: projected.sourceHandle,
    target: projected.target,
    targetHandle: projected.targetHandle,
    selected,
    data: { record: projected.record, projected: projected.projected },
  };
}

interface CanvasStoreState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** The *whole document's* containers (not just the current view's children) — needed for breadcrumb path computation, which walks a `parentId` chain that isn't limited to what's currently rendered. */
  containers: Container[];
  setNodes: (nodes: CanvasNode[]) => void;
  setEdges: (edges: CanvasEdge[]) => void;
  setContainers: (containers: Container[]) => void;
}

function createCanvasStore() {
  return create<CanvasStoreState>((set) => ({
    nodes: [],
    edges: [],
    containers: [],
    setNodes: (nodes) => set({ nodes }),
    setEdges: (edges) => set({ edges }),
    setContainers: (containers) => set({ containers }),
  }));
}

export interface UseYjsSyncResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  containers: Container[];
  onNodesChange: OnNodesChange<CanvasNode>;
  onEdgesChange: OnEdgesChange<CanvasEdge>;
  /** Wire this to `<ReactFlow onNodeDragStop={...} />` — this is the only place a drag gesture writes back into the Yjs doc. */
  onNodeDragStop: OnNodeDrag<CanvasNode>;
}

/**
 * Creates (once per `sfmDoc` identity) a Zustand store scoped to this
 * canvas mount, wires it to `sfmDoc.nodes`/`sfmDoc.edges`/`sfmDoc.containers`
 * via `.observeDeep()`, and returns everything `<ReactFlow>` needs to bind
 * to it, scoped to `containerId` (Job 013 — see this module's header
 * comment). Not a singleton — a second `<CanvasView>` mounted with a
 * different `sfmDoc` gets its own independent store.
 */
export function useYjsSync(sfmDoc: SfmDocument, containerId: string): UseYjsSyncResult {
  // Store identity intentionally follows `sfmDoc` identity, not
  // `containerId` — switching which container is viewed re-derives what
  // the *same* store holds (see the effect below), it doesn't get a fresh
  // store. A new document (e.g. a different project) does get a brand-new
  // store instead of reusing stale state from the previous one.
  const useStore = useMemo(() => createCanvasStore(), [sfmDoc]);

  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const containers = useStore((state) => state.containers);

  // The other half of the object-identity cache below (`syncAll`'s
  // `nodeCache`/`outpostCache`) — this one persists for this hook's whole
  // lifetime (not just one `containerId`), since a node's rendered
  // dimensions don't depend on which container is currently being viewed.
  // React Flow reports a node's actual measured size back through
  // `onNodesChange`'s `type: "dimensions"` change (fired once its
  // `ResizeObserver` first measures the DOM element) — this is the ONLY
  // place that value ever reaches this file, since `CanvasNode` objects
  // *we* construct never carry a `.measured` field themselves. Read by
  // `syncAll` below so a freshly-rebuilt node (its position moved, so it's
  // a new object — see that cache's own header comment) can still carry
  // its already-known size forward. This matters far beyond a paint
  // optimization: `@xyflow/system`'s `adoptUserNodes`/`parseHandles`
  // treats `!userNode.measured` as "never measured, discard whatever
  // `handleBounds` (the actual per-port coordinates every edge's endpoint
  // resolution depends on) I had for this id" — so *every* node whose
  // position changes, not just ones genuinely new, has its handle
  // positions wiped and must be fully rediscovered via `ResizeObserver`
  // from scratch. That's fine for one node moving alone (the rediscovery
  // finishes within a frame), but a multi-selection drag of several
  // machines at once resets all of them together, and React Flow's own
  // recovery for that many at once isn't reliable — confirmed by direct
  // testing: nodes come back, but some edges permanently fail to resolve
  // their endpoints and never render again until a full page reload, even
  // though the underlying document was never actually missing anything.
  // Carrying `measured` forward here means a mere position change no
  // longer looks like "never measured" at all, so `parseHandles` falls
  // through to reusing the *previous* `handleBounds` instead of discarding
  // it — correctly, since moving a node doesn't change where its handles
  // sit relative to its own card.
  const measuredByIdRef = useRef<Map<string, { width?: number; height?: number }>>(new Map());

  // Outpost I/O rework: one-time backfill for documents saved before
  // the two locked Inputs/Outputs pass-through nodes existed (`outposts/
  // io.ts`). Runs once per `sfmDoc` identity (not per `containerId` — a
  // whole-document pass, not tied to whichever container happens to be
  // open), scanning every outpost container regardless of
  // whether it's currently visible. `ensureOutpostIoNodes` is idempotent
  // (deterministic ids, checks before writing), so this is a safe no-op on
  // every subsequent mount once a document's already been backfilled, and
  // safe under two clients racing to backfill the same document at once.
  useEffect(() => {
    sfmDoc.doc.transact(() => {
      for (const container of listContainers(sfmDoc)) {
        if (container.kind === "outpost") {
          ensureOutpostIoNodes(sfmDoc, container.id, container.color);
        }
      }
    });
  }, [sfmDoc]);

  useEffect(() => {
    const { setNodes, setEdges, setContainers } = useStore.getState();

    // Object-identity cache, keyed by id — reused across every `syncAll()`
    // call for as long as this effect stays attached (fresh per `sfmDoc`/
    // `containerId`, same lifetime as the Zustand store above). Without
    // this, every single call rebuilt a brand-new `CanvasNode`/`CanvasEdge`
    // object for literally every node/edge on *every* doc change, even ones
    // whose own data hadn't changed at all — harmless in isolation, but
    // React Flow's own `adoptUserNodes` (`@xyflow/system`) only preserves a
    // node's already-measured dimensions across a `nodes` prop update when
    // it sees the *exact same object reference* for that id; a fresh object
    // every time makes it treat every node as brand-new and re-measure it
    // via `ResizeObserver` from scratch, unconditionally, on every change —
    // including ones an entirely different node caused. Under a fast,
    // rapid-fire sequence of updates (a quick node drag broadcasting its
    // final position, or several in a row) that re-measurement can never
    // catch up before the next reset arrives, and every node gets stuck
    // permanently `visibility: hidden` (React Flow's own "not measured yet"
    // style) until a full page reload — this is what was reported as a
    // dragged node's connection, then the node itself, vanishing for a
    // public read-only viewer specifically: that view's `renderedNodes`/
    // `renderedEdges` (`CanvasView.tsx`) unconditionally rebuild on every
    // render to inject `readOnly`, doing strictly more per-update work than
    // an editor's (which gets a cheap early-return whenever nothing's being
    // remotely dragged), making it the first to fall behind and never
    // recover. Reusing the previous object whenever a node/edge's own
    // *content* (and carried-over `selected` state) is unchanged means only
    // the node(s) that actually changed ever need re-measuring, so the
    // ResizeObserver dance stays proportional to what actually moved instead
    // of the whole canvas, every time.
    const nodeCache = new Map<
      string,
      { record: NodeRecord; selected: boolean; flowNode: CanvasNode; ioSignature: string | null }
    >();
    const outpostCache = new Map<
      string,
      { container: Container; ports: DerivedOutpostPort[]; selected: boolean; flowNode: CanvasNode }
    >();
    const edgeCache = new Map<string, { projected: ProjectedEdge; selected: boolean; flowEdge: CanvasEdge }>();

    // Outpost I/O rework: `outpost-input`/`outpost-output` nodes
    // (`OutpostIoNode.tsx`) are the first `NodeRecord`-backed node kind whose
    // rendered `<Handle>` SET is driven by something outside the record
    // itself — which distinct parts currently touch it via `listEdges`, not
    // by any of its own fields (unlike a recipe node, whose parts come from
    // `record.recipe`/`.machine`, already covered by `sameContent` below).
    // A brand-new named handle appearing this way is exactly what
    // `!userNode.measured` is supposed to trigger rediscovery for (see this
    // effect's own header comment on `ResizeObserver`/`handleBounds`) — so
    // this node kind needs its OWN change signal alongside `sameContent`,
    // both for cache invalidation and for deciding whether it's safe to
    // carry `.measured` forward. Returns `null` for every other kind (opted
    // out of this extra check entirely, zero behavior change for them).
    function ioHandleSignature(node: NodeRecord, edges: readonly EdgeRecord[]): string | null {
      if (node.kind !== "outpost-input" && node.kind !== "outpost-output") return null;
      const parts = new Set(
        edges.filter((edge) => edge.fromNode === node.id || edge.toNode === node.id).map((edge) => edge.part),
      );
      return [...parts].sort().join("|");
    }

    // `nodeToPlain`/`edgeToPlain`/`containerToPlain` already produce plain
    // JSON-serializable objects (no functions/`Y.*` instances), so a
    // `JSON.stringify` comparison is a correct (if not the most efficient
    // possible) deep-equality check — plenty cheap at the "tens to low
    // hundreds of nodes" scale this module's own header comment already
    // budgets for, same tolerance `syncAll`'s full-resync-on-any-change
    // discipline itself relies on.
    function sameContent(a: unknown, b: unknown): boolean {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    // Job 012's `.observeDeep` full-resync-on-any-change discipline,
    // unchanged in spirit — every doc mutation anywhere (not just ones
    // touching the current container) triggers a full re-derivation of
    // "what's visible from `containerId` right now", since Job 013 adds
    // cases where a change *elsewhere* in the doc (e.g. an edit inside a
    // child outpost) can change what's derived at this level (its boundary
    // ports). `previouslySelected*` carries `selected` over by id exactly
    // as Job 012 established — a node/container id that doesn't exist in
    // the freshly-derived list (e.g. because the view just navigated to a
    // different container) simply has nothing to carry forward, which is
    // what makes switching containers naturally drop stale selection with
    // no separate "clear selection on navigate" step (verified in this
    // job's manual browser testing — see jobs/013-outposts.md's Handoff
    // notes).
    const syncAll = () => {
      const allNodes = listNodes(sfmDoc);
      const allContainers = listContainers(sfmDoc);
      const allEdges = listEdges(sfmDoc);
      const parentOf = buildContainerParentMap(allContainers);

      const previouslySelectedNodes = new Set(
        useStore.getState().nodes.filter((node) => node.selected).map((node) => node.id),
      );
      const previouslySelectedEdges = new Set(
        useStore.getState().edges.filter((edge) => edge.selected).map((edge) => edge.id),
      );

      const directNodes = allNodes.filter((node) => node.containerId === containerId);
      const childContainers = allContainers.filter((container) => container.parentId === containerId);

      const flowNodes: CanvasNode[] = [
        ...directNodes.map((node) => {
          const selected = previouslySelectedNodes.has(node.id);
          const cached = nodeCache.get(node.id);
          const ioSignature = ioHandleSignature(node, allEdges);
          if (
            cached &&
            cached.selected === selected &&
            sameContent(cached.record, node) &&
            cached.ioSignature === ioSignature
          ) {
            return cached.flowNode;
          }
          const flowNode = nodeRecordToFlowNode(node, selected);
          const measured = measuredByIdRef.current.get(node.id);
          // Outpost I/O rework: only carry `.measured` forward when
          // this node's own handle-driving signal (`ioSignature`, `null` for
          // every non-`outpost-input`/`-output` kind) hasn't changed — see
          // this effect's `ioHandleSignature` doc comment for why a changed
          // signature means a real, new `<Handle>` needs fresh discovery.
          if (measured && cached?.ioSignature === ioSignature) flowNode.measured = measured;
          nodeCache.set(node.id, { record: node, selected, flowNode, ioSignature });
          return flowNode;
        }),
        ...childContainers.map((container) => {
          const ports = computeOutpostPorts(container.id, allNodes, allEdges, parentOf);
          const selected = previouslySelectedNodes.has(container.id);
          const cached = outpostCache.get(container.id);
          if (
            cached &&
            cached.selected === selected &&
            sameContent(cached.container, container) &&
            sameContent(cached.ports, ports)
          ) {
            return cached.flowNode;
          }
          const flowNode = containerToOutpostFlowNode(container, ports, selected);
          const measured = measuredByIdRef.current.get(container.id);
          // Outpost I/O rework: an outpost's own
          // `<Handle>` set is driven entirely by `ports` (one real handle per
          // established `${dir}:${part}` id) — carrying `.measured` forward
          // when the SET of handle ids changed (a new item just got wired,
          // not just a rate/validity update on an existing one) would tell
          // React Flow "nothing to remeasure," permanently freezing that new
          // handle's bounds and making any edge that targets it render at
          // whatever stale position an EARLIER handle happened to occupy —
          // confirmed live as "the connection dot is in the wrong spot" once
          // a wildcard-bootstrapped row got its real, named handle.
          const previousHandleIds = cached ? [...new Set(cached.ports.map((p) => p.id))].sort().join("|") : null;
          const nextHandleIds = [...new Set(ports.map((p) => p.id))].sort().join("|");
          if (measured && previousHandleIds === nextHandleIds) flowNode.measured = measured;
          outpostCache.set(container.id, { container, ports, selected, flowNode });
          return flowNode;
        }),
      ];
      // Drops cache entries for any id no longer present (deleted, or
      // navigated away from) — otherwise these maps would grow forever
      // across a long session's worth of edits.
      const currentNodeIds = new Set(directNodes.map((node) => node.id));
      for (const id of nodeCache.keys()) if (!currentNodeIds.has(id)) nodeCache.delete(id);
      const currentOutpostIds = new Set(childContainers.map((container) => container.id));
      for (const id of outpostCache.keys()) if (!currentOutpostIds.has(id)) outpostCache.delete(id);

      const visibleEdges = computeVisibleEdges(containerId, allNodes, allEdges, parentOf);
      const flowEdges: CanvasEdge[] = visibleEdges.map((projectedEdge) => {
        const selected = previouslySelectedEdges.has(projectedEdge.record.id);
        const cached = edgeCache.get(projectedEdge.record.id);
        if (cached && cached.selected === selected && sameContent(cached.projected, projectedEdge)) {
          return cached.flowEdge;
        }
        const flowEdge = projectedEdgeToFlowEdge(projectedEdge, selected);
        edgeCache.set(projectedEdge.record.id, { projected: projectedEdge, selected, flowEdge });
        return flowEdge;
      });
      const currentEdgeIds = new Set(visibleEdges.map((edge) => edge.record.id));
      for (const id of edgeCache.keys()) if (!currentEdgeIds.has(id)) edgeCache.delete(id);

      setNodes(flowNodes);
      setEdges(flowEdges);
      setContainers(allContainers);
    };

    // Initial paint — observers only fire on *future* changes, so the doc's
    // current contents (e.g. a container/node added before this effect ran,
    // or a fresh `containerId` after navigation) need one manual sync first.
    syncAll();

    // `.observeDeep` (not just `.observe`) so field-level changes inside an
    // individual node/edge/container `Y.Map` — e.g. someone else's
    // `updateNode`/`moveNode` call, whether local or (eventually) remote —
    // trigger a resync too, not just top-level add/remove of a whole
    // record. Every callback re-reads the *whole* doc rather than trying to
    // patch incrementally: `nodeToPlain`/`edgeToPlain`/`containerToPlain`
    // are cheap, the node/edge counts this job's factories deal in are
    // small (PLAN.md §2: "tens to low hundreds per outpost"), and a full
    // resync means the store can never drift from the doc.
    sfmDoc.nodes.observeDeep(syncAll);
    sfmDoc.edges.observeDeep(syncAll);
    sfmDoc.containers.observeDeep(syncAll);

    return () => {
      sfmDoc.nodes.unobserveDeep(syncAll);
      sfmDoc.edges.unobserveDeep(syncAll);
      sfmDoc.containers.unobserveDeep(syncAll);
    };
    // `containerId` is a real dependency, not incidental — see this
    // effect's own comment: switching containers must re-run `syncAll()`
    // and re-attach the observers so their closures see the new value (the
    // observers themselves don't care *which* container changed, only that
    // something did, but `syncAll`'s own body reads `containerId` directly).
  }, [sfmDoc, useStore, containerId]);

  const onNodesChange: OnNodesChange<CanvasNode> = (changes: NodeChange<CanvasNode>[]) => {
    // See `measuredByIdRef`'s own doc comment — this is the one place React
    // Flow ever reports a node's actual rendered size back to this file.
    for (const change of changes) {
      if (change.type === "dimensions" && change.dimensions) {
        measuredByIdRef.current.set(change.id, change.dimensions);
      }
    }
    const { nodes: current, setNodes } = useStore.getState();
    setNodes(applyNodeChanges(changes, current));
  };

  const onEdgesChange: OnEdgesChange<CanvasEdge> = (changes: EdgeChange<CanvasEdge>[]) => {
    const { edges: current, setEdges } = useStore.getState();
    setEdges(applyEdgeChanges(changes, current));
  };

  const onNodeDragStop: OnNodeDrag<CanvasNode> = (_event, _node, nodes) => {
    // The one and only place a drag gesture writes back into the doc — see
    // this module's header comment for why this isn't done per-frame.
    // Job 013: an outpost boundary node's id is a *container* id, not a
    // node id, so its position writes back via `updateContainer` instead of
    // `moveNode` — `node.data.container` (only ever set for a synthetic
    // outpost node, see `containerToOutpostFlowNode` above) is what
    // distinguishes the two cases; this file never touches `sfmDoc.nodes`/
    // `sfmDoc.containers`' `Y.Map` entries directly either way.
    //
    // Job 014: snap-to-grid, applied identically to both cases — an
    // outpost's on-canvas position is just as much a plain x/y as a real
    // node's, so `Settings.snapMachines`/`gridMachine` governs both (there's
    // no separate "outpost grid" setting in Job 007's schema, and PLAN.md
    // §2 only ever names "machines and waypoints", not "machines, outposts,
    // and waypoints" — an outpost boundary node is being treated as "a
    // machine, position-wise" here). Read fresh via `getSettings` at the
    // moment of drag-stop rather than a subscribed value, since this
    // callback only ever needs the *current* setting at the instant the
    // drag ends, not a value that re-renders anything.
    //
    // React Flow's third callback arg is *every* node that moved during
    // this gesture, not just the one the pointer was on — a multi-selection
    // drag moves every selected node locally (per-frame, via
    // `onNodesChange`/`applyNodeChanges`), but only writing `node`'s own
    // position back here would leave every other selected node's Yjs
    // position stale. The very next `syncAll()` (triggered by this
    // function's own `moveNode`/`updateContainer` call, via `observeDeep`)
    // then re-derives the store from the doc and those still-stale nodes
    // would snap back to wherever they were before the drag. So every
    // dragged node gets its own write-back, not just the event's `node`.
    const settings = getSettings(sfmDoc);

    // Captured before any writes below, since a dragged node's *pre*-drag
    // position only exists in the doc up until its own `moveNode`/
    // `updateContainer` call overwrites it — this is what lets an edge
    // between two co-dragged nodes translate its waypoints by the same
    // on-screen delta the nodes themselves just moved by, further down.
    const deltaById = new Map<string, { dx: number; dy: number }>();

    // Every write below happens inside ONE outer transaction — every
    // `moveNode`/`updateContainer`/`updateWaypoint` call wraps itself in its
    // own `sfmDoc.doc.transact()` (`mutations.ts`), but Yjs collapses a
    // nested `transact()` call into whichever one is already open rather
    // than starting a new one, so wrapping the whole gesture here is what
    // turns "one `Y.Doc` update (and one `observeDeep`/`afterTransaction`
    // firing on every connected client) per dragged node/waypoint" into
    // "exactly one, for the whole gesture." That distinction matters a lot
    // more than it looks: a multi-selection drag of N nodes used to fire N
    // separate updates in a tight synchronous loop, each one triggering a
    // full `syncAll()` re-derivation (`useYjsSync.ts`'s own header comment
    // on why that's a full doc re-read) *and* the client-side integrity
    // reducer (`clientIntegrity.ts`) on every connected peer, including
    // itself — and since `syncAll` handed React Flow a brand-new object for
    // every node on every one of those N passes (fixed separately, see that
    // module's own cache), a node whose position hadn't even changed YET in
    // this gesture could still get caught mid-remeasurement by the very
    // next pass. Under a large multi-select drag this pile-up was enough to
    // permanently strand every node's React Flow internals at "not yet
    // measured" (`visibility: hidden`) — the "select all the nodes and move
    // them at once makes everything disappear" report. Batching collapses
    // all of that back down to the one update a drag-stop always should
    // have produced.
    sfmDoc.doc.transact(() => {
      for (const draggedNode of nodes) {
        const position = settings.snapMachines
          ? snapPointToGrid(draggedNode.position, settings.gridMachine)
          : draggedNode.position;

        if (draggedNode.data.container) {
          const previous = getContainer(sfmDoc, draggedNode.id);
          if (previous) deltaById.set(draggedNode.id, { dx: position.x - previous.x, dy: position.y - previous.y });
          updateContainer(sfmDoc, draggedNode.id, { x: position.x, y: position.y });
        } else {
          const previous = getNode(sfmDoc, draggedNode.id);
          if (previous) deltaById.set(draggedNode.id, { dx: position.x - previous.x, dy: position.y - previous.y });
          moveNode(sfmDoc, draggedNode.id, position.x, position.y);
        }
      }

      // A waypoint is a fixed point in the container's coordinate space, not
      // relative to either endpoint — so on a single-node drag, leaving it in
      // place is correct (that's what lets a manually-routed edge keep its
      // shape while just one end moves). But when *both* of an edge's
      // endpoints were dragged together (the multi-selection case this fix's
      // header comment describes), the whole edge moved as a rigid group with
      // nothing about its routing actually changing relative to its two
      // anchors — so its waypoints need to ride along by that same delta,
      // or the route stays behind while the nodes slide out from under it.
      for (const edgeRecord of listEdges(sfmDoc)) {
        if (edgeRecord.waypoints.length === 0) continue;
        const delta = deltaById.get(edgeRecord.fromNode);
        if (!delta || !deltaById.has(edgeRecord.toNode)) continue;
        edgeRecord.waypoints.forEach((waypoint, index) => {
          updateWaypoint(sfmDoc, edgeRecord.id, index, { x: waypoint.x + delta.dx, y: waypoint.y + delta.dy });
        });
      }
    });
  };

  return { nodes, edges, containers, onNodesChange, onEdgesChange, onNodeDragStop };
}

// Re-exported so callers (e.g. dev tools) can convert a freshly-read
// `NodeRecord` into React Flow's shape without re-deriving the mapping
// logic. `edgeRecordToFlowEdge` (Jobs 009-012) was removed in Job 013: with
// edges now rendered through `computeVisibleEdges`'s projection (which
// needs the whole node/edge/container graph to resolve boundary crossings,
// not just a single record), there's no longer a meaningful one-record-in,
// one-flow-edge-out conversion to expose — `projectedEdgeToFlowEdge` above
// is this file's own private replacement, used only inside `syncAll`.
export { nodeRecordToFlowNode, containerToOutpostFlowNode };
