// Remote-presence motion smoothing: a peer's cursor/drag position only ever
// arrives as discrete samples (`throttle.ts` caps every publisher at one
// broadcast per `*_PUBLISH_INTERVAL_MS`, currently 50ms/20Hz) — rendering
// each sample the instant it lands makes remote movement look like it's
// teleporting in small steps ("jittery"), especially at higher zoom where
// each 50ms jump covers more visible pixels. `smoothDamp` is the classic
// critically-damped-spring formula (Game Programming Gems 4's "Critically
// Damped Ease-In/Ease-Out", the same one behind Unity's
// `Vector3.SmoothDamp`): unlike a naive per-frame lerp toward the latest
// sample (which restarts from zero speed every time a new sample arrives and
// so still looks like a series of little decelerations), it carries a
// velocity forward across samples, so the rendered position eases along the
// peer's actual trajectory instead of visibly re-aiming at every new target.
export interface Point {
  x: number;
  y: number;
}

export interface SmoothDampResult {
  value: number;
  velocity: number;
}

/**
 * Advances `current` one frame toward `target`, given the velocity it was
 * already carrying. `smoothTime` (seconds) is roughly the time to close most
 * of the gap to a *stationary* target — not a hard animation duration, since
 * a moving target (the normal case here) is never fully "arrived at," only
 * ever converged toward. `deltaTime` is the elapsed frame time in seconds.
 * Clamps `deltaTime` is the caller's job (a backgrounded tab's next
 * `requestAnimationFrame` can report a multi-second gap, which would
 * otherwise send `value` flying past `target`).
 */
export function smoothDamp(
  current: number,
  target: number,
  velocity: number,
  smoothTime: number,
  deltaTime: number,
): SmoothDampResult {
  // A `deltaTime` of exactly 0 (two rAF callbacks on the same timestamp,
  // which browsers do occasionally produce) would make `omega * deltaTime`
  // zero and every subsequent term degenerate — hold position/velocity
  // steady for that one frame instead of dividing by a near-zero `exp`.
  if (deltaTime <= 0) return { value: current, velocity };

  const time = Math.max(0.0001, smoothTime);
  const omega = 2 / time;
  const x = omega * deltaTime;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  const change = current - target;
  const temp = (velocity + omega * change) * deltaTime;
  const nextVelocity = (velocity - omega * temp) * exp;
  let value = target + (change + temp) * exp;

  // Overshoot guard: if the target sits behind us relative to our direction
  // of travel, `smoothDamp`'s underlying spring math can still ring past it
  // by a fraction of a pixel — clamp to the target itself rather than let
  // that show up as a barely-perceptible overshoot/settle wobble.
  if ((target - current > 0) === (value > target)) {
    value = target;
    return { value, velocity: (value - target) / deltaTime };
  }

  return { value, velocity: nextVelocity };
}

export interface SmoothDampPointResult {
  position: Point;
  velocity: Point;
}

/** `smoothDamp` applied independently to each axis — a 2D position has no cross-axis coupling worth modeling here. */
export function smoothDampPoint(
  current: Point,
  target: Point,
  velocity: Point,
  smoothTime: number,
  deltaTime: number,
): SmoothDampPointResult {
  const rx = smoothDamp(current.x, target.x, velocity.x, smoothTime, deltaTime);
  const ry = smoothDamp(current.y, target.y, velocity.y, smoothTime, deltaTime);
  return { position: { x: rx.value, y: ry.value }, velocity: { x: rx.velocity, y: ry.velocity } };
}
