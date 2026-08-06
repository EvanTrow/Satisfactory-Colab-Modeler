// Copy/cut/paste/delete logic for the current selection (Job 012 — see
// PLAN.md §2's "Select" row and §3's "cut/copy/paste/delete"). React-free
// and unit-testable directly against a real `@scm/ydoc` `createDocument()`
// fixture (same pattern `edges/connectionLogic.ts` established in Job 011)
// — nothing here touches React Flow or the Zustand store; `useMarqueeSelection
// .ts`/`useSelectionKeybinds.ts` are the thin React layers that call into
// this module with a list of currently-selected ids.
import { type EdgeRecord, type NodeRecord, type SfmDocument, addEdge, addNode, listEdges, listNodes, removeEdge, removeNode } from "@scm/ydoc";

/**
 * What a copy/cut puts on the (in-app, not OS) clipboard: the full records
 * of every copied node, plus only the edges that connect two copied nodes
 * — never an edge to a node outside the copied set (this is the acceptance
 * criterion "does not duplicate edges to nodes outside the copied set").
 */
export interface ClipboardPayload {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

/**
 * Builds a clipboard payload from a set of selected node ids. Returns
 * `null` if nothing (or nothing that still exists in the doc) is selected,
 * so callers can treat "nothing to copy" as a no-op without special-casing
 * an empty payload shape.
 *
 * `edges` is derived here, not passed in by the caller, specifically so
 * this function is the single place the "only edges between two copied
 * nodes" rule is enforced — it doesn't matter whether the caller also has
 * some of those edges individually marquee-selected or not; only endpoint
 * membership in `selectedNodeIds` decides whether an edge is copied.
 */
export function buildClipboard(sfmDoc: SfmDocument, selectedNodeIds: readonly string[]): ClipboardPayload | null {
  if (selectedNodeIds.length === 0) return null;
  const idSet = new Set(selectedNodeIds);
  const nodes = listNodes(sfmDoc).filter((node) => idSet.has(node.id));
  if (nodes.length === 0) return null;
  const edges = listEdges(sfmDoc).filter((edge) => idSet.has(edge.fromNode) && idSet.has(edge.toNode));
  return { nodes, edges };
}

export interface PasteOffset {
  dx: number;
  dy: number;
}

/** Default paste offset (px, in flow/document coordinates) so a paste doesn't land exactly on top of what it was copied from — chosen to be visually obvious without being so large the pasted group drifts off-screen for a small selection. */
export const DEFAULT_PASTE_OFFSET: PasteOffset = { dx: 40, dy: 40 };

export interface PasteResult {
  /** New node ids, in the same order as `clipboard.nodes`. */
  nodeIds: string[];
  /** New edge ids (deterministically derived from the new node ids — see `@scm/ydoc`'s `computeEdgeId`), in the same order as `clipboard.edges`. */
  edgeIds: string[];
}

/**
 * Pastes a clipboard payload into `containerId`.
 *
 * ID regeneration: every pasted node gets a brand-new id via `@scm/ydoc`'s
 * own `addNode` (no `id` is supplied, so it generates one the same way any
 * other node creation does). An old-id → new-id table is built as nodes are
 * created, then every copied edge's `fromNode`/`toNode` is remapped through
 * that table before calling `addEdge` — `addEdge`'s id is itself derived
 * from `(fromNode, fromPort, toNode, toPort)` (Job 007's deterministic
 * `computeEdgeId`), so passing the *new* endpoints automatically produces a
 * correct, fresh, deterministic edge id with no separate id-generation step
 * needed for edges.
 *
 * Relative positions: every node's `x`/`y` (and every edge's absolute
 * waypoint coordinates — Job 011 confirmed waypoints are stored as absolute
 * canvas coordinates, not offsets from their endpoints) get the *same*
 * `{dx,dy}` added, so the whole pasted group is shifted as one rigid body —
 * the distances between pasted nodes, and between an edge's waypoints and
 * its (also-shifted) endpoint nodes, are unchanged from the original
 * selection.
 *
 * Atomicity: the whole paste runs inside one `sfmDoc.doc.transact()` call.
 * `addNode`/`addEdge` each call `doc.transact()` internally too, but Yjs's
 * own `transact()` reuses the already-active outer transaction for any
 * nested call instead of starting a new one (verified against `yjs`'s own
 * source — `transact()` only creates a `new Transaction` when
 * `doc._transaction === null`), so this whole paste lands as a single Yjs
 * update and therefore a single `Y.UndoManager` stack entry — one undo step
 * for the whole pasted group, not one per node/edge.
 */
export function pasteClipboard(
  sfmDoc: SfmDocument,
  containerId: string,
  clipboard: ClipboardPayload,
  offset: PasteOffset = DEFAULT_PASTE_OFFSET,
): PasteResult {
  const nodeIds: string[] = [];
  const edgeIds: string[] = [];
  sfmDoc.doc.transact(() => {
    const idMap = new Map<string, string>();
    for (const node of clipboard.nodes) {
      const created = addNode(sfmDoc, {
        containerId,
        kind: node.kind,
        recipe: node.recipe,
        machine: node.machine,
        x: node.x + offset.dx,
        y: node.y + offset.dy,
        title: node.title,
        color: node.color,
        limit: node.limit,
        limitMode: node.limitMode,
        clock: node.clock,
        autoRound: node.autoRound,
        shards: node.shards,
        purity: node.purity,
        beltTier: node.beltTier,
        storageMode: node.storageMode,
        // `priorityOrder` entries are port ids on the node itself (which
        // outgoing port to favor), not references to other node ids, so
        // they carry over unchanged — nothing to remap.
        priorityOrder: node.priorityOrder,
      });
      idMap.set(node.id, created.id);
      nodeIds.push(created.id);
    }

    for (const edge of clipboard.edges) {
      const fromNode = idMap.get(edge.fromNode);
      const toNode = idMap.get(edge.toNode);
      // Defensive only — `buildClipboard` already guarantees every edge's
      // endpoints are both in `clipboard.nodes`, so both lookups always hit.
      if (!fromNode || !toNode) continue;
      const created = addEdge(sfmDoc, {
        containerId,
        part: edge.part,
        fromNode,
        fromPort: edge.fromPort,
        toNode,
        toPort: edge.toPort,
        waypoints: edge.waypoints.map((point) => ({ x: point.x + offset.dx, y: point.y + offset.dy })),
        style: edge.style,
        labelPos: edge.labelPos,
      });
      edgeIds.push(created.id);
    }
  });
  return { nodeIds, edgeIds };
}

/**
 * Deletes a selection of nodes and/or edges as one user action.
 *
 * Per Job 007's documented behavior (unchanged, deliberately not this
 * layer's job to alter): `removeNode` does **not** cascade to edges. So
 * deleting a node here also explicitly deletes every edge touching it
 * (either endpoint) — the same "remove dangling edges" duty
 * `RecipeNode.tsx`'s `removeEdgesForPort` performs for the single-port case
 * (Job 011), just scoped to a whole node instead of one of its ports.
 * `selectedEdgeIds` additionally covers the case of an edge selected and
 * deleted on its own, with neither endpoint node selected.
 *
 * Runs inside one `sfmDoc.doc.transact()` call for the same reason
 * `pasteClipboard` does — see that function's doc comment — so "delete
 * three nodes and their five connected edges" is one undo step, not eight.
 */
export function deleteSelection(
  sfmDoc: SfmDocument,
  selectedNodeIds: readonly string[],
  selectedEdgeIds: readonly string[],
): void {
  if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return;
  sfmDoc.doc.transact(() => {
    const nodeIdSet = new Set(selectedNodeIds);
    const edgeIdSet = new Set(selectedEdgeIds);
    for (const edge of listEdges(sfmDoc)) {
      if (edgeIdSet.has(edge.id) || nodeIdSet.has(edge.fromNode) || nodeIdSet.has(edge.toNode)) {
        removeEdge(sfmDoc, edge.id);
      }
    }
    for (const nodeId of selectedNodeIds) {
      removeNode(sfmDoc, nodeId);
    }
  });
}
