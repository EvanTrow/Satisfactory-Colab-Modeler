// Job 021: a tiny, pure, testable throttle — used by
// `CanvasView.tsx`/`useCanvasCursorPublisher.ts` to rate-limit how often a
// local mousemove gesture calls `awareness.setLocalStateField("cursor",
// ...)`. Every mousemove event over the canvas would otherwise fire an
// Awareness broadcast at native event rate (easily 60-120/s), which is both
// wasteful over the WebSocket and unnecessary — a peer's cursor doesn't need
// sub-16ms position updates to read as "live" on screen. Takes an injectable
// `now` clock (defaulting to `Date.now`) purely so this is deterministically
// testable with a fake clock instead of real `setTimeout`/real elapsed time.
export function createThrottled<Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs: number,
  now: () => number = Date.now,
): (...args: Args) => void {
  let last = -Infinity;
  return (...args: Args) => {
    const t = now();
    if (t - last >= intervalMs) {
      last = t;
      fn(...args);
    }
  };
}
