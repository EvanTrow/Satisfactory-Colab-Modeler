// Copy/cut/paste/delete logic for the current selection (Job 012 — see
// PLAN.md §2's "Select" row and §3's "cut/copy/paste/delete"). React-free
// and unit-testable directly against a real `@scm/ydoc` `createDocument()`
// fixture (same pattern `edges/connectionLogic.ts` established in Job 011)
// — nothing here touches React Flow or the Zustand store; `useMarqueeSelection
// .ts`/`useSelectionKeybinds.ts` are the thin React layers that call into
// this module with a list of currently-selected ids.
import { ContainerSchema, EdgeRecordSchema, type Container, type EdgeRecord, NodeRecordSchema, type NodeRecord, type Point, type SfmDocument, addContainer, addEdge, addNode, listContainers, listEdges, listNodes, removeEdge, removeNode } from "@scm/ydoc";
import { z } from "zod";

import { OUTPOST_INPUT_KIND, OUTPOST_OUTPUT_KIND, outpostInputNodeId, outpostOutputNodeId } from "../outposts/io";

/**
 * What a copy/cut puts on the clipboard: the full records of every copied
 * node, plus only the edges that connect two copied nodes — never an edge to
 * a node outside the copied set (this is the acceptance criterion "does not
 * duplicate edges to nodes outside the copied set").
 *
 * `containers` carries every copied outpost boundary — a selected outpost's
 * on-canvas id is a `Container.id` (`useYjsSync.ts`'s
 * `containerToOutpostFlowNode`), never present in `listNodes`, so it can't
 * ride along in `nodes`. Its contents (including any nested outposts) are
 * still `nodes`/`edges` scoped by `containerId`/`.containerId` to one of
 * these containers, same as any other node — `buildClipboard` just also
 * walks the container tree to pull those in instead of requiring every
 * descendant to be individually selected.
 */
export interface ClipboardPayload {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  containers: Container[];
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
  // Optional/defaulted so a clipboard blob written before outposts were
  // copyable (or pasted from an older tab) still round-trips instead of
  // failing validation outright.
  containers: z.array(ContainerSchema).default([]),
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
    containers: payload.containers,
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
  return { nodes: result.data.nodes, edges: result.data.edges, containers: result.data.containers };
}

/**
 * Builds a clipboard payload from a set of selected ids — a mix of real
 * `@scm/ydoc` node ids and/or outpost boundary ids (which are `Container.id`s,
 * see `ClipboardPayload`'s doc comment). Returns `null` if nothing (or
 * nothing that still exists in the doc) is selected, so callers can treat
 * "nothing to copy" as a no-op without special-casing an empty payload shape.
 *
 * A selected outpost pulls in its whole subtree: every descendant container
 * (nested outposts) plus every node scoped to any of those containers,
 * including the outpost's own locked `outpost-input`/`outpost-output`
 * pass-through nodes — none of these need to be individually selected.
 *
 * `edges` is derived here, not passed in by the caller, specifically so
 * this function is the single place the "only edges between two copied
 * nodes" rule is enforced — it doesn't matter whether the caller also has
 * some of those edges individually marquee-selected or not; only endpoint
 * membership in the resulting node set decides whether an edge is copied.
 * This also naturally excludes any edge crossing a copied outpost's
 * boundary from outside it, same as it would for a plain node.
 */
export function buildClipboard(sfmDoc: SfmDocument, selectedIds: readonly string[]): ClipboardPayload | null {
  if (selectedIds.length === 0) return null;
  const idSet = new Set(selectedIds);
  const allContainers = listContainers(sfmDoc);
  const containerById = new Map(allContainers.map((container) => [container.id, container]));

  // Parent-before-child by construction: a container is added to the map
  // before recursing into its children, and `Map` preserves insertion
  // order — `pasteClipboard` relies on this order to create a nested
  // outpost's new parent before the outpost itself.
  const containers = new Map<string, Container>();
  function collectSubtree(containerId: string): void {
    if (containers.has(containerId)) return;
    const container = containerById.get(containerId);
    if (!container) return;
    containers.set(containerId, container);
    for (const candidate of allContainers) {
      if (candidate.parentId === containerId) collectSubtree(candidate.id);
    }
  }
  for (const id of selectedIds) {
    if (containerById.has(id)) collectSubtree(id);
  }

  const allNodes = listNodes(sfmDoc);
  const nodes = allNodes.filter((node) => idSet.has(node.id) || containers.has(node.containerId));
  if (nodes.length === 0 && containers.size === 0) return null;

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = listEdges(sfmDoc).filter((edge) => nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode));
  return { nodes, edges, containers: [...containers.values()] };
}

export interface PasteOffset {
  dx: number;
  dy: number;
}

/** Default paste offset (px, in flow/document coordinates) so a paste doesn't land exactly on top of what it was copied from — chosen to be visually obvious without being so large the pasted group drifts off-screen for a small selection. Only used as a fallback by `pasteOffsetForCenter` when there's no known viewport center to target (or nothing to center). */
export const DEFAULT_PASTE_OFFSET: PasteOffset = { dx: 40, dy: 40 };

/**
 * Average x/y of a clipboard payload's nodes (and, optionally, its top-level
 * outpost containers — see `pasteOffsetForCenter`), in document/flow
 * coordinates. `null` for an empty list — nothing to center.
 */
export function clipboardCentroid(nodes: readonly NodeRecord[], containers: readonly Container[] = []): Point | null {
  const points: readonly Point[] = [...nodes, ...containers];
  if (points.length === 0) return null;
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
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
 * Only *top-level* nodes/containers (ones not scoped inside a copied
 * outpost) feed the centroid — a node inside a copied outpost lives in that
 * outpost's own internal coordinate frame, unrelated to the current view's,
 * and would badly skew the target center if mixed in (e.g. copying one
 * outpost whose boundary sits at (2000, 2000) but whose internal nodes sit
 * near (0, 0) relative to it).
 *
 * Falls back to `DEFAULT_PASTE_OFFSET` when there's no centroid (empty
 * clipboard) or no known viewport center (`center` is `null` — e.g. the
 * canvas hasn't measured its own layout yet).
 */
export function pasteOffsetForCenter(
  clipboard: Pick<ClipboardPayload, "nodes" | "containers">,
  center: Point | null,
): PasteOffset {
  const copiedContainerIds = new Set(clipboard.containers.map((container) => container.id));
  const topNodes = clipboard.nodes.filter((node) => !copiedContainerIds.has(node.containerId));
  const topContainers = clipboard.containers.filter(
    (container) => !(container.parentId && copiedContainerIds.has(container.parentId)),
  );
  const centroid = clipboardCentroid(topNodes, topContainers);
  if (!centroid || !center) return DEFAULT_PASTE_OFFSET;
  return { dx: center.x - centroid.x, dy: center.y - centroid.y };
}

export interface PasteResult {
  /** New node ids, in the same order as `clipboard.nodes`. */
  nodeIds: string[];
  /** New edge ids (deterministically derived from the new node ids — see `@scm/ydoc`'s `computeEdgeId`), in the same order as `clipboard.edges`. */
  edgeIds: string[];
  /** New container (outpost) ids, in the same order as `clipboard.containers`. */
  containerIds: string[];
}

/**
 * Pastes a clipboard payload into `containerId`.
 *
 * ID regeneration: every pasted container/node gets a brand-new id via
 * `@scm/ydoc`'s own `addContainer`/`addNode` (no `id` is supplied, so each
 * generates one the same way any other creation does) — with one exception:
 * a copied outpost's locked `outpost-input`/`outpost-output` pass-through
 * nodes are re-derived from the PASTED outpost's new container id
 * (`outposts/io.ts`'s `outpostInputNodeId`/`outpostOutputNodeId`) rather than
 * getting a random id, because the rest of the app (the outer boundary card,
 * connection routing) looks these up deterministically by container id, not
 * by scanning for `kind`. An old-id → new-id table is built for containers
 * and nodes as they're created, then every copied edge's `fromNode`/`toNode`
 * (and every copied container/node's `parentId`/`containerId`) is remapped
 * through the relevant table before use — `addEdge`'s id is itself derived
 * from `(fromNode, fromPort, toNode, toPort)` (Job 007's deterministic
 * `computeEdgeId`), so passing the *new* endpoints automatically produces a
 * correct, fresh, deterministic edge id with no separate id-generation step
 * needed for edges.
 *
 * Container order: `clipboard.containers` is parent-before-child
 * (`buildClipboard` guarantees this), so a nested outpost's copied parent
 * always already has a new id in the table by the time the nested one is
 * processed.
 *
 * Relative positions: `{dx,dy}` is added to every *top-level* node/edge/
 * container's `x`/`y` (and edge waypoints) — the same "top-level" split
 * `pasteOffsetForCenter` uses, since only those live in the current view's
 * coordinate frame. A node/edge/container scoped inside a copied outpost
 * keeps its exact original coordinates: it's already correctly positioned
 * relative to its own (also copied, and identically un-shifted) container,
 * and that container's own boundary is what gets shifted instead.
 *
 * Atomicity: the whole paste runs inside one `sfmDoc.doc.transact()` call.
 * `addContainer`/`addNode`/`addEdge` each call `doc.transact()` internally
 * too, but Yjs's own `transact()` reuses the already-active outer
 * transaction for any nested call instead of starting a new one (verified
 * against `yjs`'s own source — `transact()` only creates a `new Transaction`
 * when `doc._transaction === null`), so this whole paste lands as a single
 * Yjs update and therefore a single `Y.UndoManager` stack entry — one undo
 * step for the whole pasted group, not one per node/edge/container.
 */
export function pasteClipboard(
  sfmDoc: SfmDocument,
  containerId: string,
  clipboard: ClipboardPayload,
  offset: PasteOffset = DEFAULT_PASTE_OFFSET,
): PasteResult {
  const nodeIds: string[] = [];
  const edgeIds: string[] = [];
  const containerIds: string[] = [];
  sfmDoc.doc.transact(() => {
    const containerIdMap = new Map<string, string>();
    for (const container of clipboard.containers) {
      const nestedParent = container.parentId ? containerIdMap.get(container.parentId) : undefined;
      const newParentId = nestedParent ?? containerId;
      const shift = nestedParent === undefined;
      const created = addContainer(sfmDoc, {
        kind: container.kind,
        parentId: newParentId,
        title: container.title,
        color: container.color,
        x: shift ? container.x + offset.dx : container.x,
        y: shift ? container.y + offset.dy : container.y,
      });
      containerIdMap.set(container.id, created.id);
      containerIds.push(created.id);
    }

    const idMap = new Map<string, string>();
    for (const node of clipboard.nodes) {
      const mappedContainerId = containerIdMap.get(node.containerId);
      const newContainerId = mappedContainerId ?? containerId;
      const shift = mappedContainerId === undefined;
      // The two locked pass-through nodes need a deterministic id derived
      // from their (new) container — see this function's doc comment.
      const explicitId =
        node.kind === OUTPOST_INPUT_KIND
          ? outpostInputNodeId(newContainerId)
          : node.kind === OUTPOST_OUTPUT_KIND
            ? outpostOutputNodeId(newContainerId)
            : undefined;
      const created = addNode(sfmDoc, {
        id: explicitId,
        containerId: newContainerId,
        kind: node.kind,
        recipe: node.recipe,
        machine: node.machine,
        x: shift ? node.x + offset.dx : node.x,
        y: shift ? node.y + offset.dy : node.y,
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
        splitterVariant: node.splitterVariant,
        mergerVariant: node.mergerVariant,
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
      const mappedContainerId = containerIdMap.get(edge.containerId);
      const newContainerId = mappedContainerId ?? containerId;
      const shift = mappedContainerId === undefined;
      const dx = shift ? offset.dx : 0;
      const dy = shift ? offset.dy : 0;
      const created = addEdge(sfmDoc, {
        containerId: newContainerId,
        part: edge.part,
        fromNode,
        fromPort: edge.fromPort,
        toNode,
        toPort: edge.toPort,
        waypoints: edge.waypoints.map((point) => ({ x: point.x + dx, y: point.y + dy })),
        style: edge.style,
        labelPos: edge.labelPos,
      });
      edgeIds.push(created.id);
    }
  });
  return { nodeIds, edgeIds, containerIds };
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
