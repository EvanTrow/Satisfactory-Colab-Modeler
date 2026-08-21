// The animation-loop half of `smoothDamp.ts`'s pure spring math — takes
// whatever raw remote-presence targets a caller has *this render* (a remote
// cursor, a remote node drag, a remote waypoint drag — anything keyed by some
// id and updated at the ~20Hz `*_PUBLISH_INTERVAL_MS` cadence) and returns a
// position per key that eases toward each target every animation frame
// instead of jumping straight to it. Generic over the key type (`K`) so one
// hook serves `PresenceCursors.tsx` (keyed by Awareness `clientId`),
// `CanvasView.tsx`'s node-drag overlay (keyed by node id), and its
// waypoint/edge-drag overlays (keyed by edge id, or `edgeId:index` for group
// waypoints) without each site reimplementing the loop.
//
// Not unit-tested directly, matching this directory's established
// "extract pure logic, leave the rAF-driving hook itself untested"
// convention (see `useRemotePresence.ts`'s header comment) — the actual
// per-frame math this loop calls is fully covered in `smoothDamp.test.ts`.
import { useEffect, useRef, useState } from "react";

import { smoothDampPoint, type Point } from "./smoothDamp";

/**
 * ~2x the publishers' `*_PUBLISH_INTERVAL_MS` (50ms) — long enough that a
 * single dropped/delayed sample doesn't read as a visible stutter, short
 * enough that the rendered position still reads as "live," not laggy.
 */
const DEFAULT_SMOOTH_TIME_SECONDS = 0.1;

/** A backgrounded tab's next `requestAnimationFrame` can report a multi-second gap on refocus — clamp so the spring doesn't fling positions across the canvas trying to "catch up" in one frame. */
const MAX_DELTA_SECONDS = 0.1;

/** Below this, two positions are the same pixel on screen — skip the React re-render rather than committing sub-pixel spring noise every frame forever (the loop itself keeps running via `requestAnimationFrame` even while idle/settled, since restarting it on every `targets` change would reset the `lastTime` baseline this hook needs — see the effect's own comment — but there's no reason an *unchanged* result should still trigger a render). */
const EPSILON = 0.01;

interface TrackedEntry {
  position: Point;
  velocity: Point;
}

/**
 * Eases each `targets` entry toward its latest published value over
 * successive animation frames, using a shared per-key velocity so direction
 * changes and pauses read naturally instead of every new sample restarting
 * the animation from zero speed. A key's very first appearance snaps
 * straight to its target (no animate-in from the origin) — only *changes* to
 * an already-tracked key are smoothed. A key that disappears from `targets`
 * (peer stopped dragging/moved their cursor off-canvas) is dropped
 * immediately, matching the existing "someone stopped dragging" behavior
 * (`useDragPublisher.ts`'s `clear()` already bypasses the publish throttle
 * for exactly this reason) rather than animating out to nowhere.
 */
export function useSmoothedPositions<K>(
  targets: Map<K, Point>,
  smoothTimeSeconds = DEFAULT_SMOOTH_TIME_SECONDS,
): Map<K, Point> {
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const trackedRef = useRef<Map<K, TrackedEntry>>(new Map());
  const [rendered, setRendered] = useState<Map<K, Point>>(() => new Map(targets));
  const lastEmittedRef = useRef(rendered);

  useEffect(() => {
    let frame = 0;
    let lastTime: number | null = null;

    const tick = (time: number) => {
      const dt = lastTime === null ? 1 / 60 : Math.min(MAX_DELTA_SECONDS, (time - lastTime) / 1000);
      lastTime = time;

      const currentTargets = targetsRef.current;
      const tracked = trackedRef.current;
      for (const key of tracked.keys()) {
        if (!currentTargets.has(key)) tracked.delete(key);
      }

      const next = new Map<K, Point>();
      let changed = currentTargets.size !== lastEmittedRef.current.size;
      for (const [key, target] of currentTargets) {
        let entry = tracked.get(key);
        if (!entry) {
          entry = { position: { ...target }, velocity: { x: 0, y: 0 } };
          tracked.set(key, entry);
          changed = true;
        } else {
          const { position, velocity } = smoothDampPoint(entry.position, target, entry.velocity, smoothTimeSeconds, dt);
          entry.position = position;
          entry.velocity = velocity;
          const prev = lastEmittedRef.current.get(key);
          if (!prev || Math.abs(prev.x - entry.position.x) > EPSILON || Math.abs(prev.y - entry.position.y) > EPSILON) {
            changed = true;
          }
        }
        next.set(key, entry.position);
      }

      if (changed) {
        lastEmittedRef.current = next;
        setRendered(next);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // `targets` is deliberately not a dependency — the loop reads the latest
    // value every frame via `targetsRef` instead of restarting (and losing
    // its `lastTime` baseline, which would reset every ~50ms as new samples
    // arrive) each time the caller's target map is recreated.
  }, [smoothTimeSeconds]);

  return rendered;
}
