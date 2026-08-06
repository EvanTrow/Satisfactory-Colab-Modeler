import { describe, expect, it } from "vitest";
import { computeEdgeId } from "./edgeId";

describe("computeEdgeId", () => {
  it("is deterministic: identical inputs always produce identical output", () => {
    const a = computeEdgeId("nodeA", "out-0", "nodeB", "in-0");
    const b = computeEdgeId("nodeA", "out-0", "nodeB", "in-0");
    expect(a).toBe(b);
  });

  it("differs when any single component differs", () => {
    const base = computeEdgeId("nodeA", "out-0", "nodeB", "in-0");
    expect(computeEdgeId("nodeX", "out-0", "nodeB", "in-0")).not.toBe(base);
    expect(computeEdgeId("nodeA", "out-1", "nodeB", "in-0")).not.toBe(base);
    expect(computeEdgeId("nodeA", "out-0", "nodeY", "in-0")).not.toBe(base);
    expect(computeEdgeId("nodeA", "out-0", "nodeB", "in-1")).not.toBe(base);
  });

  it("is directional: swapping from/to endpoints produces a different id", () => {
    const forward = computeEdgeId("nodeA", "out-0", "nodeB", "in-0");
    const reverse = computeEdgeId("nodeB", "in-0", "nodeA", "out-0");
    expect(forward).not.toBe(reverse);
  });

  it("does not let field-boundary shuffling collide (NUL-separator guard)", () => {
    const a = computeEdgeId("a", "b:c", "d", "e");
    const b = computeEdgeId("a:b", "c", "d", "e");
    expect(a).not.toBe(b);
  });

  it("produces a stable, non-empty string id", () => {
    const id = computeEdgeId("nodeA", "out-0", "nodeB", "in-0");
    expect(id).toMatch(/^e_[0-9a-f]{16}$/);
  });
});
