// The visible rectangle while a right-click-drag marquee (Job 012) is in
// progress. `position: fixed` deliberately — `useMarqueeSelection.ts`'s
// `overlayRect` is built straight from `PointerEvent.clientX`/`clientY`
// (viewport coordinates), so a `fixed` box needs no bounding-rect math to
// line up with the pointer; it ignores React Flow's own pan/zoom transform
// entirely, which is exactly what's wanted here since the rect is a
// screen-space selection lasso, not something that should move/scale with
// the canvas underneath it.
import type { MarqueeOverlayRect } from "./useMarqueeSelection";

export interface MarqueeOverlayProps {
  rect: MarqueeOverlayRect;
}

export function MarqueeOverlay({ rect }: MarqueeOverlayProps) {
  return (
    <div
      className="pointer-events-none fixed z-[10000] rounded-sm border border-[var(--accent)] bg-[var(--accent-soft)]"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    />
  );
}
