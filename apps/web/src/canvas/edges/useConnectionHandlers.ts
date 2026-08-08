// Thin React hook wiring `connectionLogic.ts`'s pure connect/reconnect
// functions into `<ReactFlow>`'s callback props. Kept separate from
// `connectionLogic.ts` so that module stays plain-function/unit-testable
// (see its tests), while this file owns exactly the one bit of state that
// genuinely needs to live in a React ref: whether a reconnect drag actually
// landed on a valid target.
//
// Reconnect-vs-remove-by-drag, precisely (PLAN.md §2's Connect row: "remove
// by re-dragging... elsewhere"): this follows React Flow's own documented
// edge-reconnect pattern —
//   onReconnectStart -> reconnectSuccessfulRef = false
//   onReconnect (fires only when the drop lands on a handle
//     `isValidConnection` accepts) -> reconnectSuccessfulRef = true,
//     remove old edge + add new one (`reconnectEdge`)
//   onReconnectEnd -> if the ref is still `false` (no valid `onReconnect`
//     fired — dropped on empty canvas, on an incompatible-part handle, or
//     anywhere else `isValidConnection` rejected), delete the old edge.
// This is what makes "drag an existing connection's endpoint elsewhere"
// remove it: React Flow only ever calls `onReconnect` for a *successful*
// reconnection, so "elsewhere" (nowhere valid) always falls through to the
// `onReconnectEnd` branch.
import { useCallback, useRef } from "react";

import { removeEdge as removeEdgeRecord, type SfmDocument } from "@scm/ydoc";
import type { Connection, HandleType } from "@xyflow/react";

import type { CanvasEdge } from "../useYjsSync";
import { connectPorts, isValidPortConnection, reconnectEdge, type ConnectionLike } from "./connectionLogic";

export interface ConnectionHandlers {
  isValidConnection: (connection: ConnectionLike) => boolean;
  onConnect: (connection: Connection) => void;
  onReconnectStart: () => void;
  onReconnect: (oldEdge: CanvasEdge, newConnection: Connection) => void;
  onReconnectEnd: (event: MouseEvent | TouchEvent, edge: CanvasEdge, handleType: HandleType) => void;
  /**
   * `true` while a re-drag of an EXISTING edge's endpoint is in flight —
   * see `CanvasView.tsx`'s `onConnectEnd` wiring for why this needs to be
   * exposed: React Flow's own `onConnectEnd` fires for BOTH a brand-new
   * connection drag from a bare Handle AND a reconnect drag from an
   * existing edge's endpoint (confirmed against `@xyflow/system`'s
   * `XYHandle.onPointerDown`, which always calls the global `onConnectEnd`
   * before also calling `onReconnectEnd` when the gesture started as a
   * reconnect). Job 009's "open the Recipe Chooser on an empty-canvas
   * drop" only applies to the first case — a reconnect dropped on empty
   * canvas is already Job 011's own "remove by re-dragging elsewhere"
   * gesture (handled by `onReconnectEnd` below), not a new-node request.
   */
  isReconnecting: () => boolean;
}

export function useConnectionHandlers(sfmDoc: SfmDocument, containerId: string): ConnectionHandlers {
  // Not React state on purpose (same reasoning `CanvasFlow`'s
  // `lastPaneClickRef` uses) — this is drag-gesture bookkeeping, not
  // something whose change should trigger a render.
  const reconnectSuccessfulRef = useRef(true);
  // Set for the duration of a reconnect drag only — see `isReconnecting`'s
  // own doc comment above for why `CanvasFlow` needs this.
  const reconnectInProgressRef = useRef(false);

  const isValidConnection = useCallback((connection: ConnectionLike) => isValidPortConnection(connection), []);

  const onConnect = useCallback(
    (connection: Connection) => {
      connectPorts(sfmDoc, containerId, connection);
    },
    [sfmDoc, containerId],
  );

  const onReconnectStart = useCallback(() => {
    reconnectSuccessfulRef.current = false;
    reconnectInProgressRef.current = true;
  }, []);

  const onReconnect = useCallback(
    (oldEdge: CanvasEdge, newConnection: Connection) => {
      reconnectSuccessfulRef.current = true;
      reconnectEdge(sfmDoc, containerId, oldEdge.id, newConnection, oldEdge.data?.record.waypoints ?? []);
    },
    [sfmDoc, containerId],
  );

  const onReconnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, edge: CanvasEdge) => {
      if (!reconnectSuccessfulRef.current) {
        removeEdgeRecord(sfmDoc, edge.id);
      }
      reconnectSuccessfulRef.current = true;
      reconnectInProgressRef.current = false;
    },
    [sfmDoc],
  );

  const isReconnecting = useCallback(() => reconnectInProgressRef.current, []);

  return { isValidConnection, onConnect, onReconnectStart, onReconnect, onReconnectEnd, isReconnecting };
}
