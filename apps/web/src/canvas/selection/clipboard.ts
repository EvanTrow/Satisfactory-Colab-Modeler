// Copy/cut/paste/delete logic for the current selection (Job 012 — see
// PLAN.md §2's "Select" row and §3's "cut/copy/paste/delete"). React-free
// and unit-testable directly against a real `@scm/ydoc` `createDocument()`
// fixture (same pattern `edges/connectionLogic.ts` established in Job 011)
// — nothing here touches React Flow or the Zustand store; `useMarqueeSelection
// .ts`/`useSelectionKeybinds.ts` are the thin React layers that call into
// this module with a list of currently-selected ids.
import { EdgeRecordSchema, type EdgeRecord, NodeRecordSchema, type NodeRecord, type Point, type SfmDocument, addEdge, addNode, listEdges, listNodes, removeEdge, removeNode } from "@scm/ydoc";
import { z } from "zod";

/**
 * What a copy/cut puts on the clipboard: the full records of every copied
 * node, plus only the edges that connect two copied nodes — never an edge to
 * a node outside the copied set (this is the acceptance criterion "does not
 * duplicate edges to nodes outside the copied set").
 */
export interface ClipboardPayload {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

/**
 * On-the-wire envelope written to (and read from) the *system* clipboard —
 * this is what makes copy/paste work across projects, browser windows, and
 * between people (paste it into a chat message, the recipient copies it,
 * pastes it into their own project). `app`/`type` let `deserializeClipboard`
 * recognize and reject anything that isn't this app's own clipboard format
 * (arbitrary text the user happened to have copied, a stray JSON blob from
 * elsewhere, etc.) before it ever reaches `addNode`/`addEdge` — those trust
 * their input, so validating the shape here is the only thing standing
 * between a garbled/foreign clipboard and a corrupted shared (Yjs) document.
 */
const CLIPBOARD_FORMAT = "scm.clipboard";
const CLIPBOARD_VERSION = 1;

const ClipboardEnvelopeSchema = z.object({
  app: z.literal(CLIPBOARD_FORMAT),
  version: z.literal(CLIPBOARD_VERSION),
  nodes: z.array(NodeRecordSchema),
  edges: z.array(EdgeRecordSchema),
});

/** UTF-8-safe `btoa` — plain `btoa` throws on any code point above U+00FF, and node titles/recipe names aren't limited to Latin-1. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Inverse of `encodeBase64`. */
function decodeBase64(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Serializes a clipboard payload to the text written to the system
 * clipboard — base64-encoded (on top of the JSON envelope) so what actually
 * lands on the clipboard/in a pasted chat message reads as one opaque blob
 * of data rather than legible JSON.
 */
export function serializeClipboard(payload: ClipboardPayload): string {
  const json = JSON.stringify({
    app: CLIPBOARD_FORMAT,
    version: CLIPBOARD_VERSION,
    nodes: payload.nodes,
    edges: payload.edges,
  });
  return encodeBase64(json);
}

/**
 * Parses text read back from the system clipboard. Returns `null` for
 * anything that isn't a validly-shaped clipboard envelope from this app —
 * plain text the user copied from elsewhere, JSON from a different app,
 * invalid base64, hand-edited/corrupted text, a future/older schema
 * version — so callers can treat "not our format" as a silent no-op paste
 * rather than a crash or (far worse, since this document is shared over
 * Yjs) writing malformed records into a collaborator's live document.
 */
export function deserializeClipboard(text: string): ClipboardPayload | null {
  let json: string;
  try {
    json = decodeBase64(text);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = ClipboardEnvelopeSchema.safeParse(parsed);
  if (!result.success) return null;
  return { nodes: result.data.nodes, edges: result.data.edges };
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

/** Default paste offset (px, in flow/document coordinates) so a paste doesn't land exactly on top of what it was copied from — chosen to be visually obvious without being so large the pasted group drifts off-screen for a small selection. Only used as a fallback by `pasteOffsetForCenter` when there's no known viewport center to target (or nothing to center). */
export const DEFAULT_PASTE_OFFSET: PasteOffset = { dx: 40, dy: 40 };

/**
 * Average x/y of a clipboard payload's nodes, in document/flow coordinates.
 * `null` for an empty node list — nothing to center.
 */
export function clipboardCentroid(nodes: readonly NodeRecord[]): Point | null {
  if (nodes.length === 0) return null;
  const sum = nodes.reduce((acc, node) => ({ x: acc.x + node.x, y: acc.y + node.y }), { x: 0, y: 0 });
  return { x: sum.x / nodes.length, y: sum.y / nodes.length };
}

/**
 * The `PasteOffset` that lands a clipboard payload centered on `center`
 * (typically the current viewport's center, in flow coordinates) instead of
 * reproducing the copied position verbatim. A paste's source position is
 * frequently not even on-screen at paste time — a different project, a
 * different pan/zoom, a whole different browser window a selection got
 * pasted into from a chat message — so keeping the original coordinates
 * (this app's very first clipboard behavior) can silently place the pasted
 * group off-screen; it looks exactly like paste did nothing.
 *
 * Falls back to `DEFAULT_PASTE_OFFSET` when there's no centroid (empty
 * clipboard) or no known viewport center (`center` is `null` — e.g. the
 * canvas hasn't measured its own layout yet).
 */
export function pasteOffsetForCenter(nodes: readonly NodeRecord[], center: Point | null): PasteOffset {
  const centroid = clipboardCentroid(nodes);
  if (!centroid || !center) return DEFAULT_PASTE_OFFSET;
  return { dx: center.x - centroid.x, dy: center.y - centroid.y };
}

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
        splurgerVariant: node.splurgerVariant,
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
