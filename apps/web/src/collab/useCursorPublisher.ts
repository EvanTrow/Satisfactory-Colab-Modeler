// Job 021: turns raw pointer movement over the canvas into throttled
// `awareness.setLocalStateField("cursor", ...)` calls — the local half of
// `PresenceCursors.tsx`'s rendering. Mounted once in `CanvasView.tsx`'s
// `CanvasFlow`, whose `handlePointerMove` calls this hook's `onPointerMove`
// alongside Job 012's marquee-selection `pointerHandlers.onPointerMove` on
// the same wrapper `<div>` (both need the event, so `CanvasFlow` merges them
// into one handler rather than letting either clobber the other via a plain
// JSX prop spread).
//
// Deliberately Pointer events, not Mouse events (this used to be
// `onMouseMove`/`onMouseLeave`, wired straight onto the wrapper div) — a
// real bug found via manual multi-tab testing: while a node drag is in
// progress, a dragging user's own cursor appeared frozen to every other
// peer for the whole gesture. Root cause, confirmed by reading
// `d3-drag`'s source (`@xyflow/react`'s node-drag machinery is built on
// it): `d3-drag`'s `mousedowned` attaches its own `window`-level,
// **capture-phase** `mousemove` listener for the duration of the drag, and
// every move calls `event.stopImmediatePropagation()` — which runs before
// any other `mousemove` listener anywhere in the document can, including
// React's own delegated root listener behind `onMouseMove`. So the wrapper
// div's `onMouseMove` genuinely never fired for the entire drag. `d3-drag`
// only ever touches `mousedown`/`mousemove`/`mouseup` (never the separate
// Pointer Events stream), so `pointermove` sails through completely
// unaffected — switching to it fixes the freeze with no other behavior
// change.
import { useEffect, useMemo } from "react";

import type { AwarenessCursor } from "./awareness";
import { createThrottled } from "./throttle";

/** How often (ms) a mousemove gesture is allowed to actually publish a new cursor position — see `throttle.ts`'s header comment for why this exists at all. 50ms (20/s) is plenty smooth for a presence cursor, which only needs to *read* as live, not track every pixel of native mouse-move resolution. */
const CURSOR_PUBLISH_INTERVAL_MS = 50;

export interface CursorPublisherHandlers {
  onPointerMove: (event: { clientX: number; clientY: number }) => void;
  onPointerLeave: () => void;
}

export function useCursorPublisher(
  setCursor: (cursor: AwarenessCursor | null) => void,
  containerId: string,
  screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number },
): CursorPublisherHandlers {
  const throttledSetCursor = useMemo(
    () => createThrottled((cursor: AwarenessCursor) => setCursor(cursor), CURSOR_PUBLISH_INTERVAL_MS),
    [setCursor],
  );

  // A container switch (drill-in / breadcrumb navigation, Job 013) makes
  // whatever flow-space position was last published meaningless in the new
  // view's coordinate space — clear it immediately rather than letting a
  // stale position sit there. In practice this also just makes the cursor
  // vanish from every peer's screen (since its `containerId` no longer
  // matches anything they're viewing either) until the next mousemove
  // re-publishes a fresh, correct one.
  useEffect(() => {
    setCursor(null);
  }, [containerId, setCursor]);

  return {
    onPointerMove: (event) => {
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      throttledSetCursor({ x: flow.x, y: flow.y, containerId });
    },
    onPointerLeave: () => setCursor(null),
  };
}
