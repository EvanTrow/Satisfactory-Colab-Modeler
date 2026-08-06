// Pure(-ish — the `connect*`/`reconnect*` functions take an `SfmDocument`
// and call straight into `@scm/ydoc`'s mutation helpers, but none of them
// touch React/React Flow) connect/reconnect/part-compatibility logic for
// Job 011. Kept separate from `useConnectionHandlers.ts` (the thin React
// hook that wires these into `<ReactFlow>`'s callback props) so it's
// unit-testable the same way Jobs 009/010 tested `filters.ts`/
// `recipeNodeMath.ts` — no DOM, no React Flow provider, just a real
// `createDocument()` fixture.
import { addEdge as addEdgeRecord, removeEdge as removeEdgeRecord, type EdgeRecord, type SfmDocument, type Waypoint } from "@scm/ydoc";

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
 * Also where mismatched-part rejection lives: returns `null` if either
 * side is missing/unparseable, both sides are the same direction (two
 * inputs or two outputs), or the two sides' part names don't match.
 */
export function resolveEdgeEndpoints(connection: ConnectionLike): ResolvedEndpoints | null {
  if (!connection.source || !connection.target) return null;

  const sourceInfo = parsePortHandleId(connection.sourceHandle);
  const targetInfo = parsePortHandleId(connection.targetHandle);
  if (!sourceInfo || !targetInfo) return null;
  if (sourceInfo.part !== targetInfo.part) return null;

  if (sourceInfo.direction === "out" && targetInfo.direction === "in") {
    return {
      fromNode: connection.source,
      fromPort: connection.sourceHandle as string,
      toNode: connection.target,
      toPort: connection.targetHandle as string,
      part: sourceInfo.part,
    };
  }
  if (sourceInfo.direction === "in" && targetInfo.direction === "out") {
    return {
      fromNode: connection.target,
      fromPort: connection.targetHandle as string,
      toNode: connection.source,
      toPort: connection.sourceHandle as string,
      part: sourceInfo.part,
    };
  }
  // Both "in" or both "out" — not a valid input/output pair (shouldn't
  // happen given `RecipeNode`'s Handle `type`s and React Flow's default
  // `connectionMode="strict"`, but rejected explicitly rather than assumed
  // away).
  return null;
}

/** Wired to `<ReactFlow isValidConnection={...} />` — accepts a `Connection` mid-drag or a full `Edge` (React Flow calls it with either). */
export function isValidPortConnection(connection: ConnectionLike): boolean {
  return resolveEdgeEndpoints(connection) !== null;
}

/**
 * Completes a drag-to-connect gesture: resolves + validates the connection,
 * then creates the edge via `@scm/ydoc`'s idempotent `addEdge`. Returns
 * `null` (no-op, no edge created) for a mismatched-part or otherwise
 * invalid connection — in normal UI use this is already blocked earlier by
 * `isValidPortConnection` wired to `isValidConnection`, but this function
 * re-validates on its own so it's safe (and correctly tested) to call
 * directly too.
 */
export function connectPorts(sfmDoc: SfmDocument, containerId: string, connection: ConnectionLike): EdgeRecord | null {
  const resolved = resolveEdgeEndpoints(connection);
  if (!resolved) return null;
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
  const resolved = resolveEdgeEndpoints(newConnection);
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
