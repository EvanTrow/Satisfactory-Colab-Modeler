// Mutation helpers — the only sanctioned way to write to a `SfmDocument`'s
// content. Every exported function here wraps its writes in a single
// `doc.transact(...)` call (per jobs/007-ydoc-schema.md's acceptance
// criteria: "All mutation helpers use doc.transact() so they batch into
// single Yjs update events"), and every function accepts an optional
// `origin` so callers can tag transactions — e.g. the reserved
// `origin: 'integrity'` from `undo.ts` (Job 022's integrity reducer), or a
// per-user id once Job 012 wires up per-user undo scoping. Leaving `origin`
// unset produces Yjs's default local-transaction origin (`null`), which is
// what `createUndoManager` tracks by default.
import * as Y from "yjs";
import type { SfmDocument } from "./document";
import { containerToPlain, edgeToPlain, nodeToPlain } from "./document";
import { computeEdgeId } from "./edgeId";
import type { Container, EdgeRecord, NodeRecord, Waypoint } from "./schema";

function generateId(prefix: string): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (globalCrypto?.randomUUID) {
    return `${prefix}${globalCrypto.randomUUID()}`;
  }
  // Fallback for environments without Web Crypto (deliberately avoids
  // importing `node:crypto`, which wouldn't bundle for `apps/web`'s
  // browser build). Not cryptographically strong, but Yjs map keys only
  // need to avoid *accidental* collision within one document; timestamp +
  // random suffix is plenty for that.
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${random}`;
}

function pointToMap(point: Waypoint): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("x", point.x);
  map.set("y", point.y);
  return map;
}

// ---------------------------------------------------------------------------
// containers
// ---------------------------------------------------------------------------

export type NewContainerInput = Omit<Container, "id"> & { id?: string };
export type ContainerPatch = Partial<Omit<Container, "id">>;

export function addContainer(
  sfmDoc: SfmDocument,
  input: NewContainerInput,
  origin?: unknown,
): Container {
  const id = input.id ?? generateId("c_");
  let result!: Container;
  sfmDoc.doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("id", id);
    map.set("kind", input.kind);
    map.set("parentId", input.parentId);
    map.set("title", input.title);
    map.set("color", input.color);
    map.set("x", input.x);
    map.set("y", input.y);
    map.set("copiesLimit", input.copiesLimit);
    sfmDoc.containers.set(id, map);
    result = containerToPlain(map);
  }, origin);
  return result;
}

export function updateContainer(
  sfmDoc: SfmDocument,
  containerId: string,
  patch: ContainerPatch,
  origin?: unknown,
): Container {
  let result!: Container;
  sfmDoc.doc.transact(() => {
    const map = sfmDoc.containers.get(containerId);
    if (!map) {
      throw new Error(`updateContainer: no container with id "${containerId}"`);
    }
    for (const [key, value] of Object.entries(patch)) {
      map.set(key, value);
    }
    result = containerToPlain(map);
  }, origin);
  return result;
}

/**
 * Removes a container. Does **not** cascade to child nodes/containers or
 * reparent them to root — that repair is the integrity reducer's job
 * (Job 022, PLAN.md §5's "Reparent orphaned nodes to the root container"
 * bullet), deliberately out of scope here.
 */
export function removeContainer(sfmDoc: SfmDocument, containerId: string, origin?: unknown): void {
  sfmDoc.doc.transact(() => {
    sfmDoc.containers.delete(containerId);
  }, origin);
}

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

export type NewNodeInput = Omit<NodeRecord, "id" | "priorityOrder"> & {
  id?: string;
  priorityOrder?: string[];
};
export type NodePatch = Partial<Omit<NodeRecord, "id" | "priorityOrder">>;

export function addNode(sfmDoc: SfmDocument, input: NewNodeInput, origin?: unknown): NodeRecord {
  const id = input.id ?? generateId("n_");
  let result!: NodeRecord;
  sfmDoc.doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("id", id);
    map.set("containerId", input.containerId);
    map.set("kind", input.kind);
    map.set("recipe", input.recipe);
    map.set("machine", input.machine);
    map.set("x", input.x);
    map.set("y", input.y);
    map.set("title", input.title);
    map.set("color", input.color);
    map.set("limit", input.limit);
    map.set("limitMode", input.limitMode);
    map.set("clock", input.clock);
    map.set("autoRound", input.autoRound);
    map.set("shards", input.shards);
    map.set("purity", input.purity);
    map.set("beltTier", input.beltTier);
    map.set("storageMode", input.storageMode);
    const priorityOrder = new Y.Array<string>();
    if (input.priorityOrder?.length) {
      priorityOrder.push(input.priorityOrder);
    }
    map.set("priorityOrder", priorityOrder);
    sfmDoc.nodes.set(id, map);
    result = nodeToPlain(map);
  }, origin);
  return result;
}

/** Field-level update. Does not touch `priorityOrder` — use `setPriorityOrder`. */
export function updateNode(
  sfmDoc: SfmDocument,
  nodeId: string,
  patch: NodePatch,
  origin?: unknown,
): NodeRecord {
  let result!: NodeRecord;
  sfmDoc.doc.transact(() => {
    const map = sfmDoc.nodes.get(nodeId);
    if (!map) {
      throw new Error(`updateNode: no node with id "${nodeId}"`);
    }
    for (const [key, value] of Object.entries(patch)) {
      map.set(key, value);
    }
    result = nodeToPlain(map);
  }, origin);
  return result;
}

/** Convenience wrapper over `updateNode` for the common drag-to-move case. */
export function moveNode(
  sfmDoc: SfmDocument,
  nodeId: string,
  x: number,
  y: number,
  origin?: unknown,
): NodeRecord {
  return updateNode(sfmDoc, nodeId, { x, y }, origin);
}

export function setPriorityOrder(
  sfmDoc: SfmDocument,
  nodeId: string,
  order: string[],
  origin?: unknown,
): NodeRecord {
  let result!: NodeRecord;
  sfmDoc.doc.transact(() => {
    const map = sfmDoc.nodes.get(nodeId);
    if (!map) {
      throw new Error(`setPriorityOrder: no node with id "${nodeId}"`);
    }
    const priorityOrder = map.get("priorityOrder") as Y.Array<string>;
    priorityOrder.delete(0, priorityOrder.length);
    if (order.length) {
      priorityOrder.push(order);
    }
    result = nodeToPlain(map);
  }, origin);
  return result;
}

/**
 * Removes a node. Does **not** cascade-delete edges pointing at it — see
 * PLAN.md §5's integrity reducer note; that repair pass (Job 022) is what
 * deletes dangling edges after a concurrent delete-vs-connect. Callers that
 * want immediate local cleanup should also call `removeEdge` themselves.
 */
export function removeNode(sfmDoc: SfmDocument, nodeId: string, origin?: unknown): void {
  sfmDoc.doc.transact(() => {
    sfmDoc.nodes.delete(nodeId);
  }, origin);
}

// ---------------------------------------------------------------------------
// edges
// ---------------------------------------------------------------------------

export type NewEdgeInput = Omit<EdgeRecord, "id" | "waypoints"> & { waypoints?: Waypoint[] };
export type EdgePatch = Partial<
  Omit<EdgeRecord, "id" | "containerId" | "fromNode" | "fromPort" | "toNode" | "toPort" | "waypoints">
>;

/**
 * Creates an edge with the deterministic id derived from
 * `(fromNode, fromPort, toNode, toPort)` (see `edgeId.ts`). **Idempotent**:
 * if an edge with that id already exists, its existing fields are left
 * untouched and it is returned as-is — this is what makes two concurrent
 * `addEdge` calls for the same connection converge to one entry instead of
 * one clobbering the other's waypoints/style. Use `updateEdge` to change an
 * existing edge's non-endpoint fields.
 */
export function addEdge(sfmDoc: SfmDocument, input: NewEdgeInput, origin?: unknown): EdgeRecord {
  const id = computeEdgeId(input.fromNode, input.fromPort, input.toNode, input.toPort);
  let result!: EdgeRecord;
  sfmDoc.doc.transact(() => {
    const existing = sfmDoc.edges.get(id);
    if (existing) {
      result = edgeToPlain(existing);
      return;
    }
    const map = new Y.Map<unknown>();
    map.set("id", id);
    map.set("containerId", input.containerId);
    map.set("part", input.part);
    map.set("fromNode", input.fromNode);
    map.set("fromPort", input.fromPort);
    map.set("toNode", input.toNode);
    map.set("toPort", input.toPort);
    const waypoints = new Y.Array<Y.Map<unknown>>();
    if (input.waypoints?.length) {
      waypoints.push(input.waypoints.map(pointToMap));
    }
    map.set("waypoints", waypoints);
    map.set("style", input.style ?? null);
    map.set("labelPos", input.labelPos ?? null);
    sfmDoc.edges.set(id, map);
    result = edgeToPlain(map);
  }, origin);
  return result;
}

export function updateEdge(
  sfmDoc: SfmDocument,
  edgeId: string,
  patch: EdgePatch,
  origin?: unknown,
): EdgeRecord {
  let result!: EdgeRecord;
  sfmDoc.doc.transact(() => {
    const map = sfmDoc.edges.get(edgeId);
    if (!map) {
      throw new Error(`updateEdge: no edge with id "${edgeId}"`);
    }
    for (const [key, value] of Object.entries(patch)) {
      map.set(key, value);
    }
    result = edgeToPlain(map);
  }, origin);
  return result;
}

export function removeEdge(sfmDoc: SfmDocument, edgeId: string, origin?: unknown): void {
  sfmDoc.doc.transact(() => {
    sfmDoc.edges.delete(edgeId);
  }, origin);
}

/**
 * Reparents an edge to a different `containerId`. Deliberately **not** part
 * of `updateEdge`'s `EdgePatch` (which excludes `containerId` alongside the
 * endpoint fields) — `containerId` isn't part of an edge's identity the way
 * `fromNode`/`fromPort`/`toNode`/`toPort` are (it doesn't participate in
 * `computeEdgeId`), so moving an edge to a different container doesn't need
 * the remove-then-add dance `updateEdge`'s own doc comment describes for
 * endpoint changes. Added for Job 013 (outposts): deleting an outpost
 * container reparents its former children to the parent container rather
 * than destroying them (PLAN.md §5's "reparent orphaned nodes to root"
 * principle, applied locally) — nodes already had a way to do this via
 * `updateNode`'s patch, edges didn't.
 */
export function reparentEdge(
  sfmDoc: SfmDocument,
  edgeId: string,
  containerId: string,
  origin?: unknown,
): EdgeRecord {
  let result!: EdgeRecord;
  sfmDoc.doc.transact(() => {
    const map = sfmDoc.edges.get(edgeId);
    if (!map) {
      throw new Error(`reparentEdge: no edge with id "${edgeId}"`);
    }
    map.set("containerId", containerId);
    result = edgeToPlain(map);
  }, origin);
  return result;
}

function getWaypointsArray(sfmDoc: SfmDocument, edgeId: string): Y.Array<Y.Map<unknown>> {
  const map = sfmDoc.edges.get(edgeId);
  if (!map) {
    throw new Error(`no edge with id "${edgeId}"`);
  }
  return map.get("waypoints") as Y.Array<Y.Map<unknown>>;
}

/** Inserts a waypoint at `index` (appends if `index` is omitted or past the end). */
export function addWaypoint(
  sfmDoc: SfmDocument,
  edgeId: string,
  point: Waypoint,
  index?: number,
  origin?: unknown,
): EdgeRecord {
  let result!: EdgeRecord;
  sfmDoc.doc.transact(() => {
    const waypoints = getWaypointsArray(sfmDoc, edgeId);
    const insertAt = index === undefined ? waypoints.length : Math.min(index, waypoints.length);
    waypoints.insert(insertAt, [pointToMap(point)]);
    result = edgeToPlain(sfmDoc.edges.get(edgeId)!);
  }, origin);
  return result;
}

export function removeWaypoint(
  sfmDoc: SfmDocument,
  edgeId: string,
  index: number,
  origin?: unknown,
): EdgeRecord {
  let result!: EdgeRecord;
  sfmDoc.doc.transact(() => {
    const waypoints = getWaypointsArray(sfmDoc, edgeId);
    if (index < 0 || index >= waypoints.length) {
      throw new Error(`removeWaypoint: index ${index} out of range (length ${waypoints.length})`);
    }
    waypoints.delete(index, 1);
    result = edgeToPlain(sfmDoc.edges.get(edgeId)!);
  }, origin);
  return result;
}

export function updateWaypoint(
  sfmDoc: SfmDocument,
  edgeId: string,
  index: number,
  patch: Partial<Waypoint>,
  origin?: unknown,
): EdgeRecord {
  let result!: EdgeRecord;
  sfmDoc.doc.transact(() => {
    const waypoints = getWaypointsArray(sfmDoc, edgeId);
    const point = waypoints.get(index);
    if (!point) {
      throw new Error(`updateWaypoint: index ${index} out of range (length ${waypoints.length})`);
    }
    for (const [key, value] of Object.entries(patch)) {
      point.set(key, value);
    }
    result = edgeToPlain(sfmDoc.edges.get(edgeId)!);
  }, origin);
  return result;
}
