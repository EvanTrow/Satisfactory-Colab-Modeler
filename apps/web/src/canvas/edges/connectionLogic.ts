// Pure(-ish — the `connect*`/`reconnect*` functions take an `SfmDocument`
// and call straight into `@scm/ydoc`'s mutation helpers, but none of them
// touch React/React Flow) connect/reconnect/part-compatibility logic for
// Job 011. Kept separate from `useConnectionHandlers.ts` (the thin React
// hook that wires these into `<ReactFlow>`'s callback props) so it's
// unit-testable the same way Jobs 009/010 tested `filters.ts`/
// `recipeNodeMath.ts` — no DOM, no React Flow provider, just a real
// `createDocument()` fixture.
import { defaultGameData } from "@scm/gamedata";
import {
  addEdge as addEdgeRecord,
  computeEdgeId,
  getContainer,
  getEdge,
  getNode,
  listEdges,
  removeEdge as removeEdgeRecord,
  type EdgeRecord,
  type SfmDocument,
  type Waypoint,
} from "@scm/ydoc";

import { outpostInputNodeId, outpostOutputNodeId } from "../outposts/io";
import { decodeSplitterConfig, parseWildcardSlot, splitterSlotConfig } from "../nodes/splitMergeConfig";

/**
 * Job 010's port `Handle` id contract: `${"in"|"out"}:${part name}`. See
 * `RecipeNode.tsx`'s `PartRow` (and jobs/010's Handoff notes) for where
 * this is produced. Split on the *first* `:` only, since a part's display
 * name is never expected to contain one but this keeps the parse
 * unambiguous either way.
 */
export interface PortInfo {
  direction: "in" | "out";
  part: string;
}

export function parsePortHandleId(handleId: string | null | undefined): PortInfo | null {
  if (!handleId) return null;
  const separatorIndex = handleId.indexOf(":");
  if (separatorIndex === -1) return null;
  const direction = handleId.slice(0, separatorIndex);
  const part = handleId.slice(separatorIndex + 1);
  if ((direction !== "in" && direction !== "out") || part.length === 0) return null;
  return { direction, part };
}

/**
 * Structural subset of React Flow's `Connection`/`Edge` shared by both —
 * lets `resolveEdgeEndpoints`/`isValidPortConnection` accept either without
 * importing `@xyflow/react` here.
 */
export interface ConnectionLike {
  source: string | null | undefined;
  sourceHandle?: string | null | undefined;
  target: string | null | undefined;
  targetHandle?: string | null | undefined;
}

export interface ResolvedEndpoints {
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
  part: string;
}

/**
 * The part name a routing node's single-side generic handle uses — a
 * Splitter's `in:*` input, a Merger's `out:*` output, and an outpost I/O
 * node's own single handle. None of these have a fixed recipe to build real
 * `${dir}:${part}` handles from ahead of time the way `RecipeNode.tsx`'s
 * `PartRow` does — they accept ANY part, and the connection's real part name
 * comes from whichever real recipe port is on the other end. See
 * `reconcilePart`/`isWildcardPart` below for exactly how this interacts with
 * the existing exact-part-match rule.
 */
export const WILDCARD_PART = "*";

/**
 * A Splitter's 3 output handles / a Merger's 3 input handles each need their
 * own unique id (React Flow requires unique ids among handles of the same
 * type on one node — plain `in:*`/`out:*` duplicated wouldn't work), so each
 * is its own wildcard SENTINEL — still a wildcard for part-matching purposes
 * (see `isWildcardPart`), but distinguishable by POSITION from its siblings.
 * `SplitterNode.tsx`/`MergerNode.tsx` and the solver-side routing
 * (`workers/splitMergePassthrough.ts`) both derive which slot an edge is
 * anchored to straight from `EdgeRecord.fromPort`/`.toPort` itself — no
 * separate bookkeeping needed. Re-exported here (defined in
 * `canvas/nodes/splitMergeConfig.ts`, a dependency-free module shared by this
 * file and the solver routing) so every other caller of this module's port
 * helpers has one single import path.
 */
export { wildcardSlot, parseWildcardSlot, type SlotIndex } from "../nodes/splitMergeConfig";

/** True for `WILDCARD_PART` itself or a positional slot sentinel — anything that defers to the OTHER side's real part name rather than naming one of its own. */
export function isWildcardPart(part: string): boolean {
  return part.startsWith(WILDCARD_PART);
}

/**
 * Reconciles two ports' part names for a connection: an exact match, or a
 * wildcard side (see `isWildcardPart` — a Splitter/Merger/outpost I/O node's
 * generic handles) deferring to the other side's real part name. Two
 * wildcard sides (e.g. a direct Splitter-to-Merger wire with neither end
 * anchored to a real recipe part) has no real part to assign and is
 * rejected — `EdgeRecord.part` is a required, non-nullable string, so there
 * is no "unknown part" value to fall back to.
 */
function reconcilePart(a: string, b: string): string | null {
  const aWild = isWildcardPart(a);
  const bWild = isWildcardPart(b);
  if (aWild && bWild) return null;
  if (aWild) return b;
  if (bWild) return a;
  return a === b ? a : null;
}

/**
 * A `kind: "depot"` target node has two restrictions beyond an AWESOME
 * Sink's own unconstrained wildcard input (`SinkNode.tsx`'s header comment)
 * — matching the real Dimensional Depot Uploader's in-game behavior: it
 * can't accept a fluid/gas raw at all (`@scm/gamedata`'s `Part.fluid`), and
 * it only ever holds ONE item type, so a second, DIFFERENT part can't be
 * wired in once it already has an incoming edge from a different one. `true`
 * (nothing to gate) for every other node kind, or when `toNode` doesn't
 * resolve to a real record for any reason (defensive — every connection's
 * target should already exist).
 */
function isDepotConnectionAllowed(sfmDoc: SfmDocument, toNode: string, part: string): boolean {
  const target = getNode(sfmDoc, toNode);
  if (!target || target.kind !== "depot") return true;
  if (defaultGameData.partsByName.get(part)?.fluid === true) return false;
  return listEdges(sfmDoc)
    .filter((edge) => edge.toNode === toNode)
    .every((edge) => edge.part === part);
}

/**
 * A Storage Container (`kind: "storage"`) holds exactly one item type —
 * `StorageNode.tsx`'s redesign collapsed it from "allow multiple, flag
 * visually" down to a hard rule, matching a Dimensional Depot Uploader's own
 * single-item restriction just above. Rejects a new connection touching
 * either side of a storage node whose existing edges already carry a
 * DIFFERENT part; `true` (nothing to gate) once every incident edge (if any)
 * already agrees with `part`, or when neither side is a storage node at all.
 */
function isStorageConnectionAllowed(sfmDoc: SfmDocument, fromNode: string, toNode: string, part: string): boolean {
  for (const nodeId of [fromNode, toNode]) {
    const node = getNode(sfmDoc, nodeId);
    if (!node || node.kind !== "storage") continue;
    const hasOtherPart = listEdges(sfmDoc).some(
      (edge) => (edge.fromNode === nodeId || edge.toNode === nodeId) && edge.part !== part,
    );
    if (hasOtherPart) return false;
  }
  return true;
}

/**
 * A Smart/Programmable Splitter's output slots (`kind: "splitter"`,
 * `splitterVariant` `"smart"`/`"programmable"`) each carry a routing rule
 * (`canvas/nodes/splitMergeConfig.ts`'s `SplitterSlotConfig`) that restricts
 * which item can be wired there: `"none"` never accepts a connection,
 * `"item"` only accepts one of its configured part names, and every other
 * rule (`"any"`/`"undefined"`/`"overflow"`) accepts anything — those rules
 * only affect solve-time priority (`workers/splitMergePassthrough.ts`), not
 * which item can be wired. A Conveyor Splitter (`"basic"` variant, or any
 * other node kind) has no rules at all — always allowed. Merger inputs are
 * never gated by item (a Priority Merger's priority is per-slot, not
 * per-item), so there's no equivalent check for `toNode`.
 */
function isSplitterOutputConnectionAllowed(sfmDoc: SfmDocument, fromNode: string, fromPort: string, part: string): boolean {
  const node = getNode(sfmDoc, fromNode);
  if (!node || node.kind !== "splitter") return true;
  if (node.splitterVariant !== "smart" && node.splitterVariant !== "programmable") return true;
  const slot = parseWildcardSlot(parsePortHandleId(fromPort)?.part ?? "");
  if (slot === null) return true;
  const slotConfig = splitterSlotConfig(decodeSplitterConfig(node.priorityOrder), slot);
  if (slotConfig.rule === "none") return false;
  if (slotConfig.rule === "item") return slotConfig.items.includes(part);
  return true;
}

/**
 * A Storage Container's own `Handle`s stay plain wildcards forever (never
 * renamed to the real part — see `StorageNode.tsx`'s header for why: an
 * `EdgeRecord.fromPort`/`.toPort` is fixed at connect time, so a Handle
 * whose id changed later would silently orphan the edge already anchored to
 * the old one). That means `parsePortHandleId` alone can't tell a caller
 * what item a storage node actually holds — this reads it straight off
 * whichever edge (either side) is currently wired to it instead, since
 * `isStorageConnectionAllowed` above guarantees every incident edge agrees.
 * `undefined` when nothing is connected yet. Used by `CanvasView.tsx`'s
 * `handleConnectEnd` so dragging FROM a storage node's output pre-filters
 * the Recipe Chooser by the real held part, the same way dragging from a
 * real recipe port already does, instead of falling back to "unfiltered."
 */
export function storageNodePart(sfmDoc: SfmDocument, nodeId: string): string | undefined {
  return listEdges(sfmDoc).find((edge) => edge.fromNode === nodeId || edge.toNode === nodeId)?.part;
}

/**
 * Normalizes a React-Flow-`Connection`-shaped object into `@scm/ydoc`'s
 * directional `fromNode/fromPort -> toNode/toPort` edge endpoints, with
 * `fromPort` always the `"out:"` handle and `toPort` always the `"in:"`
 * handle — **regardless of which side React Flow reported as
 * `source`/`target`**.
 *
 * React Flow is documented to already normalize `Connection.source`/
 * `.target` to the literal source-type/target-type handle no matter which
 * one the user physically started dragging from (confirmed in this job's
 * manual browser verification — see Handoff notes), which is what makes
 * "drag output->input or input->output, both produce the same edge" work.
 * This function does its own symmetric check anyway (accepting either
 * arrangement, as long as directions are complementary) as defense in
 * depth: if that normalization were ever wrong, `addEdge`'s deterministic
 * id is directional, so getting `fromNode`/`fromPort` backwards would
 * silently create a *different* edge instead of erroring.
 *
 * Also where mismatched-part rejection (and, via `isDepotConnectionAllowed`,
 * Dimensional Depot's own fluid/single-item-type rejection) lives: returns
 * `null` if either side is missing/unparseable, both sides are the same
 * direction (two inputs or two outputs), the two sides' part names don't
 * match, or the resolved connection would violate a Depot's restrictions.
 */
export function resolveEdgeEndpoints(sfmDoc: SfmDocument, connection: ConnectionLike): ResolvedEndpoints | null {
  if (!connection.source || !connection.target) return null;

  const sourceInfo = parsePortHandleId(connection.sourceHandle);
  const targetInfo = parsePortHandleId(connection.targetHandle);
  if (!sourceInfo || !targetInfo) return null;
  const part = reconcilePart(sourceInfo.part, targetInfo.part);
  if (part === null) return null;

  let resolved: ResolvedEndpoints;
  if (sourceInfo.direction === "out" && targetInfo.direction === "in") {
    resolved = {
      fromNode: connection.source,
      fromPort: connection.sourceHandle as string,
      toNode: connection.target,
      toPort: connection.targetHandle as string,
      part,
    };
  } else if (sourceInfo.direction === "in" && targetInfo.direction === "out") {
    resolved = {
      fromNode: connection.target,
      fromPort: connection.targetHandle as string,
      toNode: connection.source,
      toPort: connection.sourceHandle as string,
      part,
    };
  } else {
    // Both "in" or both "out" — not a valid input/output pair (shouldn't
    // happen given `RecipeNode`'s Handle `type`s and React Flow's default
    // `connectionMode="strict"`, but rejected explicitly rather than assumed
    // away).
    return null;
  }

  // Outpost rework: dragging a connection straight onto the outer
  // boundary card (`OutpostNode.tsx`) reports that
  // card's own flow-node id, which IS the `Container` id (see
  // `useYjsSync.ts`'s `containerToOutpostFlowNode`). Redirect it to the
  // container's own locked pass-through node — the Outputs node when it's
  // acting as `fromNode` (flow leaving the container), the Inputs node when
  // it's `toNode` (flow entering it) — so the persisted edge always names a
  // real `NodeRecord` on both ends, exactly like every other connection.
  // Falls back to the unredirected id if that pass-through node doesn't
  // exist yet (a legacy document whose one-time backfill hasn't landed) —
  // defensive only; `getContainer` returning `undefined` for an ordinary
  // node id (the overwhelmingly common case) makes this a no-op then.
  resolved.fromNode = redirectContainerEndpoint(sfmDoc, resolved.fromNode, "from");
  resolved.toNode = redirectContainerEndpoint(sfmDoc, resolved.toNode, "to");

  if (!isDepotConnectionAllowed(sfmDoc, resolved.toNode, part)) return null;
  if (!isStorageConnectionAllowed(sfmDoc, resolved.fromNode, resolved.toNode, part)) return null;
  if (!isSplitterOutputConnectionAllowed(sfmDoc, resolved.fromNode, resolved.fromPort, part)) return null;
  return resolved;
}

function redirectContainerEndpoint(sfmDoc: SfmDocument, nodeId: string, role: "from" | "to"): string {
  const container = getContainer(sfmDoc, nodeId);
  if (!container) return nodeId;
  const ioNodeId = role === "from" ? outpostOutputNodeId(container.id) : outpostInputNodeId(container.id);
  return getNode(sfmDoc, ioNodeId) ? ioNodeId : nodeId;
}

/** Wired to `<ReactFlow isValidConnection={...} />` — accepts a `Connection` mid-drag or a full `Edge` (React Flow calls it with either). */
export function isValidPortConnection(sfmDoc: SfmDocument, connection: ConnectionLike): boolean {
  return resolveEdgeEndpoints(sfmDoc, connection) !== null;
}

/**
 * A minimal, structural description of a rendered `<Handle>` — the subset of
 * React Flow's own `useConnection()` `fromHandle` shape `isValidDragCandidate`
 * needs. Kept local (not imported from `@xyflow/react`) for the same reason
 * `ConnectionLike` is: this file stays usable from plain unit tests with no
 * React Flow provider.
 */
export interface HandleRef {
  nodeId: string;
  id?: string | null;
  type: "source" | "target";
}

/**
 * While a connection is being dragged out from `from`, would dropping it on
 * `candidate` produce a valid edge? Every node component's Handle-rendering
 * code calls this (via `useConnection()`'s live `fromHandle`) to dim every
 * handle that isn't a legal drop target, so only the ones a drag could
 * actually land on stay at full opacity — PLAN.md's connection-drag
 * affordance improvement.
 *
 * Two handles of the same `type` (both `"source"` or both `"target"`) are
 * rejected up front without touching `isValidPortConnection` at all — this
 * app's default `connectionMode="strict"` never treats same-type handles as
 * a valid pair regardless of part, the same rule `resolveEdgeEndpoints`
 * itself enforces via its direction check, just phrased here in terms of
 * React Flow's `type` rather than this app's own `"in"`/`"out"` port
 * direction (the two aren't the same axis: a user can start a drag from
 * either a `"target"` or a `"source"` handle, so `from.type` alone doesn't
 * tell you which side of the eventual `ConnectionLike` it belongs on — the
 * source/target assignment below does that).
 */
export function isValidDragCandidate(sfmDoc: SfmDocument, from: HandleRef, candidate: HandleRef): boolean {
  if (from.type === candidate.type) return false;
  const sourceSide = from.type === "source" ? from : candidate;
  const targetSide = from.type === "source" ? candidate : from;
  return isValidPortConnection(sfmDoc, {
    source: sourceSide.nodeId,
    sourceHandle: sourceSide.id,
    target: targetSide.nodeId,
    targetHandle: targetSide.id,
  });
}

/**
 * Completes a drag-to-connect gesture: resolves + validates the connection,
 * then **toggles** the edge — creates it if the two ports aren't already
 * connected, removes it if they are. This is what makes "drag from a node
 * to another node that already has that connection" a disconnect gesture
 * instead of the no-op `addEdge`'s own idempotency would otherwise produce:
 * both drags resolve to the same deterministic `computeEdgeId`, so a second
 * drag over an existing connection is indistinguishable from a first one
 * except by checking `getEdge` first.
 *
 * Returns `null` for a mismatched-part or otherwise invalid connection (no
 * edge created) as well as for the toggle-off case (edge removed) — in
 * normal UI use invalid connections are already blocked earlier by
 * `isValidPortConnection` wired to `isValidConnection`, but this function
 * re-validates on its own so it's safe (and correctly tested) to call
 * directly too. Callers that need to distinguish "removed" from "invalid"
 * can check `getEdge` themselves; today's only caller (`onConnect`) doesn't
 * need to.
 */
export function connectPorts(sfmDoc: SfmDocument, containerId: string, connection: ConnectionLike): EdgeRecord | null {
  const resolved = resolveEdgeEndpoints(sfmDoc, connection);
  if (!resolved) return null;
  const edgeId = computeEdgeId(resolved.fromNode, resolved.fromPort, resolved.toNode, resolved.toPort);
  if (getEdge(sfmDoc, edgeId)) {
    removeEdgeRecord(sfmDoc, edgeId);
    return null;
  }
  return addEdgeRecord(sfmDoc, { containerId, ...resolved, style: null, labelPos: null });
}

/**
 * Completes a successful re-drag of an existing edge's endpoint onto a new,
 * valid target: removes the old edge and creates the new one (the id is
 * derived from the endpoints, so "reconnect" is necessarily
 * remove-then-add, per `@scm/ydoc`'s own `updateEdge` docs), carrying
 * `preserveWaypoints` over onto the new record so the visual route doesn't
 * snap back to a straight line just because the connection's identity
 * changed.
 *
 * Returns `null` (old edge left untouched) if `newConnection` doesn't
 * resolve — callers should treat that the same as "the drag ended nowhere
 * valid" and remove the old edge themselves (this is what
 * `useConnectionHandlers`'s `onReconnectEnd` does, via the
 * reconnect-succeeded ref React Flow's own reconnect example pattern uses;
 * see that module for why the two are split across two callbacks).
 */
export function reconnectEdge(
  sfmDoc: SfmDocument,
  containerId: string,
  oldEdgeId: string,
  newConnection: ConnectionLike,
  preserveWaypoints: readonly Waypoint[] = [],
): EdgeRecord | null {
  const resolved = resolveEdgeEndpoints(sfmDoc, newConnection);
  if (!resolved) return null;
  removeEdgeRecord(sfmDoc, oldEdgeId);
  return addEdgeRecord(sfmDoc, {
    containerId,
    ...resolved,
    waypoints: [...preserveWaypoints],
    style: null,
    labelPos: null,
  });
}
