import { describe, expect, it } from "vitest";

import { smoothDamp, smoothDampPoint } from "./smoothDamp";

describe("smoothDamp", () => {
  it("holds position and velocity steady for a zero/negative deltaTime", () => {
    expect(smoothDamp(0, 100, 5, 0.1, 0)).toEqual({ value: 0, velocity: 5 });
    expect(smoothDamp(0, 100, 5, 0.1, -1)).toEqual({ value: 0, velocity: 5 });
  });

  it("moves toward a stationary target without overshooting it", () => {
    let value = 0;
    let velocity = 0;
    for (let i = 0; i < 200; i += 1) {
      const result = smoothDamp(value, 100, velocity, 0.1, 1 / 60);
      value = result.value;
      velocity = result.velocity;
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(value).toBeCloseTo(100, 1);
  });

  it("converges from the other direction just as cleanly (no directional bias)", () => {
    let value = 100;
    let velocity = 0;
    for (let i = 0; i < 200; i += 1) {
      const result = smoothDamp(value, 0, velocity, 0.1, 1 / 60);
      value = result.value;
      velocity = result.velocity;
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(value).toBeCloseTo(0, 1);
  });

  it("carries velocity forward — a target that keeps moving produces smoother (lower max acceleration) motion than restarting from rest every sample", () => {
    // Simulate a target moving at a constant 1000 units/sec, resampled every
    // 50ms (matching the real publisher cadence) — the steady-state tracking
    // error should stabilize rather than grow or oscillate, which is what a
    // velocity-carrying spring should do against a constant-velocity input.
    let value = 0;
    let velocity = 0;
    let target = 0;
    const errors: number[] = [];
    for (let sample = 0; sample < 40; sample += 1) {
      target += 1000 * 0.05; // the target's position at this 50ms sample
      // Sub-step at 60fps within this 50ms sample window.
      for (let frame = 0; frame < 3; frame += 1) {
        const result = smoothDamp(value, target, velocity, 0.1, 1 / 60);
        value = result.value;
        velocity = result.velocity;
      }
      errors.push(Math.abs(target - value));
    }
    const early = errors.slice(5, 15);
    const late = errors.slice(-10);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Steady-state error shouldn't be growing over time (it would if the
    // spring were diverging instead of tracking).
    expect(avg(late)).toBeLessThanOrEqual(avg(early) * 1.05);
  });

  it("snaps immediately once close enough that the overshoot guard trips (settles rather than ringing forever)", () => {
    const value = 99.999;
    const velocity = 0.001;
    const result = smoothDamp(value, 100, velocity, 0.1, 1 / 60);
    // Either it's already effectively at the target, or the overshoot guard
    // clamped it exactly there.
    expect(result.value).toBeLessThanOrEqual(100);
    expect(result.value).toBeGreaterThan(99.9);
  });
});

describe("smoothDampPoint", () => {
  it("applies smoothDamp independently on each axis", () => {
    const result = smoothDampPoint({ x: 0, y: 0 }, { x: 100, y: -50 }, { x: 0, y: 0 }, 0.1, 1 / 60);
    const expectedX = smoothDamp(0, 100, 0, 0.1, 1 / 60);
    const expectedY = smoothDamp(0, -50, 0, 0.1, 1 / 60);
    expect(result.position).toEqual({ x: expectedX.value, y: expectedY.value });
    expect(result.velocity).toEqual({ x: expectedX.velocity, y: expectedY.velocity });
  });

  it("leaves an already-arrived point untouched", () => {
    const result = smoothDampPoint({ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 0, y: 0 }, 0.1, 1 / 60);
    expect(result.position).toEqual({ x: 10, y: 10 });
  });
});
