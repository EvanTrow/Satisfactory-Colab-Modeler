// The edge-level sibling of `useDragPublisher.ts`: turns `ConnectionEdge.tsx`'s
// own local optimistic waypoint/label-drag state (`dragIndex`/`dragPoint`,
// `labelDragIndex`/`labelDragPoint`) into throttled
// `awareness.setLocalStateField("edgeDragging", ...)` calls, so every other
// peer sees a waypoint (or the bare label being dragged to create the first
// one) glide live instead of jumping into place only once the drag ends and
// `updateWaypoint`/`addWaypoint` commits to the doc. One instance is mounted
// per `ConnectionEdge` (unlike `useDragPublisher`, mounted once for the whole
// canvas) since each edge owns its own independent drag gesture and state.
import { useEffect, useMemo } from "react";

import type { AwarenessEdgeDragging } from "./awareness";
import { createThrottled } from "./throttle";

/** Same cadence as `useDragPublisher.ts`'s `DRAG_PUBLISH_INTERVAL_MS` — a dragged waypoint only needs to *read* as live. */
const EDGE_DRAG_PUBLISH_INTERVAL_MS = 50;

export interface EdgeDragPublishPoint {
  mode: "move" | "insert";
  waypointIndex: number;
  x: number;
  y: number;
}

export interface EdgeDragPublisherHandlers {
  /** Call on every pointermove of an active waypoint/label drag. Throttled — safe to call at native drag-move frequency. */
  publish: (point: EdgeDragPublishPoint) => void;
  /** Call once the drag gesture ends (committed or cancelled) — bypasses the throttle so the live indicator disappears from every peer's screen immediately. */
  clear: () => void;
}

export function useEdgeDragPublisher(
  setEdgeDragging: (edgeDragging: AwarenessEdgeDragging | null) => void,
  containerId: string,
  edgeId: string,
): EdgeDragPublisherHandlers {
  const throttledSet = useMemo(
    () =>
      createThrottled(
        (point: EdgeDragPublishPoint) => setEdgeDragging({ containerId, edgeId, ...point }),
        EDGE_DRAG_PUBLISH_INTERVAL_MS,
      ),
    [setEdgeDragging, containerId, edgeId],
  );

  // A container switch makes any in-flight drag published from the
  // *previous* view meaningless here — clear it immediately, mirroring
  // `useDragPublisher.ts`'s identical behavior.
  useEffect(() => {
    setEdgeDragging(null);
  }, [containerId, edgeId, setEdgeDragging]);

  return {
    publish: (point) => throttledSet(point),
    clear: () => setEdgeDragging(null),
  };
}
