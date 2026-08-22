// Live drag broadcasting: turns in-progress `onNodesChange` position events
// into throttled `awareness.setLocalStateField("dragging", ...)` calls, so
// every other peer sees a node (or Job 013 outpost boundary node)
// glide across the canvas as it's dragged — not just jump to its final spot
// once the dragger releases it, which is all `useYjsSync.ts`'s
// `onNodeDragStop` (a single write, at drag end) provided on its own.
// Mirrors `useCursorPublisher.ts`'s throttle-a-high-frequency-gesture shape
// exactly, but driven by React Flow's own `NodePositionChange` events
// (`CanvasView.tsx`'s `CanvasFlow` wraps `sync.onNodesChange` to feed this)
// rather than raw mousemove.
import { useEffect, useMemo } from "react";

import type { AwarenessDragging, AwarenessDraggingNode, AwarenessDraggingWaypoint } from "./awareness";
import { createThrottled } from "./throttle";

/** Same cadence as `useCursorPublisher.ts`'s `CURSOR_PUBLISH_INTERVAL_MS` — a dragged node only needs to *read* as live, not track every pixel of native drag-move resolution. */
const DRAG_PUBLISH_INTERVAL_MS = 50;

export interface DragPublisherHandlers {
  /**
   * Call with every currently-in-flight dragged node/container's live
   * position, on every `onNodesChange` batch that contains a `dragging:
   * true` position change. `waypoints` carries along any marquee-selected
   * waypoints riding with this same group drag (`CanvasView.tsx`'s
   * `handleNodesChange`) — omit or pass `[]` when none are. Throttled —
   * safe to call at native drag-move frequency.
   */
  publish: (nodes: AwarenessDraggingNode[], waypoints?: AwarenessDraggingWaypoint[]) => void;
  /** Call once a drag gesture ends (the batch's `dragging` flips to `false`) — bypasses the throttle so the "someone is dragging this" indicator disappears from every peer's screen immediately, not up to `DRAG_PUBLISH_INTERVAL_MS` late. */
  clear: () => void;
}

export function useDragPublisher(
  setDragging: (dragging: AwarenessDragging | null) => void,
  containerId: string,
): DragPublisherHandlers {
  const throttledSetDragging = useMemo(
    () =>
      createThrottled(
        (nodes: AwarenessDraggingNode[], waypoints: AwarenessDraggingWaypoint[]) =>
          setDragging({ containerId, nodes, waypoints }),
        DRAG_PUBLISH_INTERVAL_MS,
      ),
    [setDragging, containerId],
  );

  // A container switch (drill-in / breadcrumb navigation) makes any
  // in-flight drag published from the *previous* view meaningless here —
  // clear it immediately, mirroring `useCursorPublisher.ts`'s identical
  // "clear on containerId change" behavior.
  useEffect(() => {
    setDragging(null);
  }, [containerId, setDragging]);

  return {
    publish: (nodes, waypoints = []) => throttledSetDragging(nodes, waypoints),
    clear: () => setDragging(null),
  };
}
