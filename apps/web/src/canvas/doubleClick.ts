// Pure, React-free double-click/double-right-click detection, extracted out
// of `CanvasView.tsx`'s inline `onPaneClick` bookkeeping (Job 009) so Job
// 011's connection-label and waypoint-marker gestures can reuse the exact
// same "is this the second click of a pair" rule instead of re-deriving it.
//
// Why manual detection instead of the browser's native `dblclick` event:
// `dblclick` only ever fires for the primary (left) mouse button per the
// UI Events spec, so it can't detect a double-*right*-click at all — and
// PLAN.md's Waypoints row needs exactly that ("double-right-click a
// waypoint deletes it; double-right-click a bare label deletes the
// connection"). Tracking left and right clicks through this same
// time+distance rule (rather than native `dblclick` for left and something
// bespoke for right) keeps both gestures behaviorally identical, which is
// what a user would expect.
export interface ClickPoint {
  time: number;
  x: number;
  y: number;
}

/** Matches `CanvasFlow`'s original inline constants (Job 009). */
export const DOUBLE_CLICK_MS = 400;
export const DOUBLE_CLICK_PX = 12;

/**
 * True if `now` is close enough in time and screen distance to `last` to
 * count as the second click of a double-click. Callers are responsible for
 * clearing their own `last` ref after a positive result so a third click
 * starts a fresh pair rather than immediately re-triggering.
 */
export function isDoubleClick(
  last: ClickPoint | null,
  now: ClickPoint,
  msThreshold: number = DOUBLE_CLICK_MS,
  pxThreshold: number = DOUBLE_CLICK_PX,
): boolean {
  if (!last) return false;
  return now.time - last.time <= msThreshold && Math.hypot(now.x - last.x, now.y - last.y) <= pxThreshold;
}
