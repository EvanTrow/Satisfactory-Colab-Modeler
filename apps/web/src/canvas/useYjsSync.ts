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
//         from `@scm/ydoc`'s mutations.ts --> Yjs doc updates --> the
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
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import {
  type Container,
  type EdgeRecord,
  type NodeRecord,
  type SfmDocument,
  listContainers,
  listEdges,
  listNodes,
  moveNode,
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

/**
 * The full `NodeRecord` rides along in `data` for whichever job needs it —
 * `RecipeNode.tsx` (Job 010) is the first real consumer, reading
 * `data.record` directly rather than re-fetching from the doc on every
 * render. `label` remains for React Flow's built-in "default" node type,
 * still used for any `kind` Job 010 doesn't own a custom renderer for (e.g.
 * `kind: "debug"` from `DevNodeTools`, or the not-yet-built splurger/
 * storage/outpost kinds).
 */
export interface CanvasNodeData extends Record<string, unknown> {
  record: NodeRecord;
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
 * The full `EdgeRecord` rides along in `data`, same reasoning as
 * `CanvasNodeData.record` — `ConnectionEdge.tsx` (Job 011) reads
 * `data.record` directly (waypoints, `part`, `labelPos`) rather than
 * re-fetching from the doc on every render, and `useConnectionHandlers.ts`
 * reads `oldEdge.data.record.waypoints` in its `onReconnect` handler to
 * carry waypoints over onto the reconnected edge.
 */
export interface CanvasEdgeData extends Record<string, unknown> {
  record: EdgeRecord;
}

export type CanvasEdge = RFEdge<CanvasEdgeData>;

function nodeRecordToFlowNode(record: NodeRecord): CanvasNode {
  return {
    // `kind: "recipe"` is the only kind with a real custom node type so far
    // (`RecipeNode`, registered under the `"recipe"` key in
    // `CanvasView.tsx`'s `nodeTypes`) — every other kind (splurger/storage/
    // outpost, none built yet, plus the `"debug"` kind `DevNodeTools` uses)
    // falls back to React Flow's built-in "default" box, same as every kind
    // did before this job.
    id: record.id,
    type: record.kind === "recipe" ? "recipe" : "default",
    position: { x: record.x, y: record.y },
    data: { record, label: record.title || record.kind || record.id, validityState: null },
  };
}

function edgeRecordToFlowEdge(record: EdgeRecord): CanvasEdge {
  return {
    id: record.id,
    // `"part"` is Job 011's custom edge type (`ConnectionEdge`, registered
    // under that key in `CanvasView.tsx`'s `edgeTypes`) — every edge in
    // this app carries a `part`, so unlike nodes (which fall back to
    // React Flow's built-in "default" for non-`"recipe"` kinds) there's no
    // untyped fallback case here.
    type: "part",
    source: record.fromNode,
    sourceHandle: record.fromPort,
    target: record.toNode,
    targetHandle: record.toPort,
    data: { record },
  };
}

interface CanvasStoreState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Synced from `sfmDoc.containers` for completeness (Job 008's scope explicitly includes subscribing to `containers`), unused by rendering until outposts (Job 013) exist. */
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
 * to it. Not a singleton — a second `<CanvasView>` mounted with a different
 * `sfmDoc` gets its own independent store.
 */
export function useYjsSync(sfmDoc: SfmDocument): UseYjsSyncResult {
  // Store identity intentionally follows `sfmDoc` identity: a new document
  // (e.g. a different project) gets a brand-new store instead of reusing
  // stale state from the previous one.
  const useStore = useMemo(() => createCanvasStore(), [sfmDoc]);

  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const containers = useStore((state) => state.containers);

  useEffect(() => {
    const { setNodes, setEdges, setContainers } = useStore.getState();

    const syncNodes = () => setNodes(listNodes(sfmDoc).map(nodeRecordToFlowNode));
    const syncEdges = () => setEdges(listEdges(sfmDoc).map(edgeRecordToFlowEdge));
    const syncContainers = () => setContainers(listContainers(sfmDoc));

    // Initial paint — observers only fire on *future* changes, so the doc's
    // current contents (e.g. a container/node added before this effect ran)
    // need one manual sync first.
    syncNodes();
    syncEdges();
    syncContainers();

    // `.observeDeep` (not just `.observe`) so field-level changes inside an
    // individual node/edge/container `Y.Map` — e.g. someone else's
    // `updateNode`/`moveNode` call, whether local or (eventually) remote —
    // trigger a resync too, not just top-level add/remove of a whole
    // record. Every callback re-reads the *whole* map rather than trying to
    // patch incrementally: `nodeToPlain`/`edgeToPlain`/`containerToPlain`
    // are cheap, the node/edge counts this job's factories deal in are
    // small (PLAN.md §2: "tens to low hundreds per outpost"), and a full
    // resync means the store can never drift from the doc.
    sfmDoc.nodes.observeDeep(syncNodes);
    sfmDoc.edges.observeDeep(syncEdges);
    sfmDoc.containers.observeDeep(syncContainers);

    return () => {
      sfmDoc.nodes.unobserveDeep(syncNodes);
      sfmDoc.edges.unobserveDeep(syncEdges);
      sfmDoc.containers.unobserveDeep(syncContainers);
    };
  }, [sfmDoc, useStore]);

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
    // `moveNode` is `@scm/ydoc`'s mutation helper (thin sugar over
    // `updateNode`); this file never touches `sfmDoc.nodes`'s `Y.Map`
    // entries directly.
    moveNode(sfmDoc, node.id, node.position.x, node.position.y);
  };

  return { nodes, edges, containers, onNodesChange, onEdgesChange, onNodeDragStop };
}

// Re-exported so callers (e.g. dev tools, and later Job 009's Recipe
// Chooser) can convert a freshly-read `NodeRecord`/`EdgeRecord` into React
// Flow's shape without re-deriving the mapping logic.
export { nodeRecordToFlowNode, edgeRecordToFlowEdge };
