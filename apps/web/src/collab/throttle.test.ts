import { describe, expect, it } from "vitest";

import { createThrottled } from "./throttle";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createThrottled", () => {
  it("calls through on the very first invocation", () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const throttled = createThrottled((n: number) => calls.push(n), 50, clock.now);

    throttled(1);
    expect(calls).toEqual([1]);
  });

  it("suppresses calls that arrive before the interval has elapsed", () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const throttled = createThrottled((n: number) => calls.push(n), 50, clock.now);

    throttled(1);
    clock.advance(10);
    throttled(2);
    clock.advance(10);
    throttled(3);
    expect(calls).toEqual([1]);
  });

  it("lets a call through once the interval has fully elapsed since the last one that fired", () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const throttled = createThrottled((n: number) => calls.push(n), 50, clock.now);

    throttled(1);
    clock.advance(49);
    throttled(2); // still suppressed
    clock.advance(1); // now exactly 50ms since the last fired call
    throttled(3);
    expect(calls).toEqual([1, 3]);
  });

  it("passes arguments through unchanged", () => {
    const clock = fakeClock();
    const calls: Array<{ x: number; y: number }> = [];
    const throttled = createThrottled((point: { x: number; y: number }) => calls.push(point), 10, clock.now);

    throttled({ x: 1, y: 2 });
    expect(calls).toEqual([{ x: 1, y: 2 }]);
  });
});
