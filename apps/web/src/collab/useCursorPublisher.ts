// Job 021: turns raw mouse movement over the canvas into throttled
// `awareness.setLocalStateField("cursor", ...)` calls — the local half of
// `PresenceCursors.tsx`'s rendering. Mounted once in `CanvasView.tsx`'s
// `CanvasFlow`, which spreads the returned `onMouseMove`/`onMouseLeave`
// handlers onto the same wrapper `<div>` that already carries Job 012's
// marquee-selection `pointerHandlers` (those use Pointer events, not Mouse
// events, so there's no handler collision — see that hook for the pointer/
// mouse split).
import { useEffect, useMemo } from "react";

import type { AwarenessCursor } from "./awareness";
import { createThrottled } from "./throttle";

/** How often (ms) a mousemove gesture is allowed to actually publish a new cursor position — see `throttle.ts`'s header comment for why this exists at all. 50ms (20/s) is plenty smooth for a presence cursor, which only needs to *read* as live, not track every pixel of native mouse-move resolution. */
const CURSOR_PUBLISH_INTERVAL_MS = 50;

export interface CursorPublisherHandlers {
  onMouseMove: (event: { clientX: number; clientY: number }) => void;
  onMouseLeave: () => void;
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
    onMouseMove: (event) => {
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      throttledSetCursor({ x: flow.x, y: flow.y, containerId });
    },
    onMouseLeave: () => setCursor(null),
  };
}
