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
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import {
  type Container,
  type EdgeRecord,
  type NodeRecord,
  type SfmDocument,
  getSettings,
  listContainers,
  listEdges,
  listNodes,
  moveNode,
  updateContainer,
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
}

export type CanvasNode = RFNode<CanvasNodeData>;

/**
 * The full `EdgeRecord` rides along in `data` (ground truth — endpoints,
 * waypoints, `part`, `labelPos` — even for a boundary-projected edge, whose
 * *rendered* top-level `source`/`target`/`sourceHandle`/`targetHandle`
 * below may differ from this record's own `fromNode`/`toNode`/`fromPort`/
 * `toPort`; see `outposts/visibleGraph.ts`). `ConnectionEdge.tsx` (Job 011)
 * and `outposts/BoundaryEdge.tsx` (Job 013) both read `data.record` rather
 * than re-fetching from the doc on every render.
 */
export interface CanvasEdgeData extends Record<string, unknown> {
  record: EdgeRecord;
  /**
   * True when this edge's rendered endpoints were redirected to an
   * outpost's boundary node (Job 013) — i.e. this isn't the edge's own
   * literal `fromNode`/`toNode`. `BoundaryEdge.tsx` is used instead of
   * `ConnectionEdge.tsx` whenever this is true (`useYjsSync.ts` picks the
   * edge `type` accordingly), specifically so the interactive waypoint
   * gestures (which assume `record.waypoints` are meaningful in *this*
   * container's coordinate space) never run against a boundary projection —
   * the stored waypoints belong to whichever container the edge was
   * originally drawn in, which is generally not this one.
   */
  projected?: boolean;
}

export type CanvasEdge = RFEdge<CanvasEdgeData>;

function nodeRecordToFlowNode(record: NodeRecord, selected = false): CanvasNode {
  return {
    // `kind: "recipe"` (`RecipeNode`) and, since Job 024, `kind: "splurger"`
    // (`SplurgerNode`) are the only kinds with a real custom node type so
    // far — both registered in `CanvasView.tsx`'s `nodeTypes`. Every other
    // kind (storage, none built yet, plus the `"debug"` kind `DevNodeTools`
    // uses) falls back to React Flow's built-in "default" box, same as
    // every kind did before Job 010.
    id: record.id,
    type: record.kind === "recipe" ? "recipe" : record.kind === "splurger" ? "splurger" : "default",
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

/** Converts a `ProjectedEdge` (`outposts/visibleGraph.ts`) into the flow edge shape — `type: "boundary"` for a projected (boundary-crossing) edge, `type: "part"` (Job 011's `ConnectionEdge`) for a normal direct one, exactly as before Job 013. */
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

  useEffect(() => {
    const { setNodes, setEdges, setContainers } = useStore.getState();

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
        ...directNodes.map((node) => nodeRecordToFlowNode(node, previouslySelectedNodes.has(node.id))),
        ...childContainers.map((container) => {
          const ports = computeOutpostPorts(container.id, allNodes, allEdges, parentOf);
          return containerToOutpostFlowNode(container, ports, previouslySelectedNodes.has(container.id));
        }),
      ];

      const visibleEdges = computeVisibleEdges(containerId, allNodes, allEdges, parentOf);
      const flowEdges: CanvasEdge[] = visibleEdges.map((projectedEdge) =>
        projectedEdgeToFlowEdge(projectedEdge, previouslySelectedEdges.has(projectedEdge.record.id)),
      );

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
    const { nodes: current, setNodes } = useStore.getState();
    setNodes(applyNodeChanges(changes, current));
  };

  const onEdgesChange: OnEdgesChange<CanvasEdge> = (changes: EdgeChange<CanvasEdge>[]) => {
    const { edges: current, setEdges } = useStore.getState();
    setEdges(applyEdgeChanges(changes, current));
  };

  const onNodeDragStop: OnNodeDrag<CanvasNode> = (_event, node) => {
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
    const settings = getSettings(sfmDoc);
    const position = settings.snapMachines
      ? snapPointToGrid(node.position, settings.gridMachine)
      : node.position;

    if (node.data.container) {
      updateContainer(sfmDoc, node.id, { x: position.x, y: position.y });
    } else {
      moveNode(sfmDoc, node.id, position.x, position.y);
    }
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
