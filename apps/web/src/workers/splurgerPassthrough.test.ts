import { describe, expect, it } from "vitest";

import {
  computeSplurgerPassthroughEdges,
  computeSplurgerShape,
  decodePriorityOrder,
  encodePriorityOrder,
  moveWithinTier,
  setTier,
  tierForEdge,
  tierGroupsForCaps,
  withDefaultedEdges,
  withoutStaleEdges,
  type SplurgerEdgeLike,
} from "./splurgerPassthrough";

function edge(overrides: Partial<SplurgerEdgeLike> & { id: string }): SplurgerEdgeLike {
  return { part: "Iron Ore", fromNode: "a", fromPort: "out", toNode: "b", toPort: "in", ...overrides };
}

describe("priority-order encode/decode", () => {
  it("round-trips top/bottom tokens", () => {
    const assignment = { top: ["e1", "e2"], bottom: ["e3"] };
    const encoded = encodePriorityOrder(assignment);
    expect(encoded).toEqual(["top:e1", "top:e2", "bottom:e3"]);
    expect(decodePriorityOrder(encoded)).toEqual(assignment);
  });

  it("ignores unrecognized tokens defensively", () => {
    expect(decodePriorityOrder(["garbage", "top:e1"])).toEqual({ top: ["e1"], bottom: [] });
  });

  it("tierForEdge returns undefined for an unassigned edge (defaults to top per @scm/solver's own convention)", () => {
    expect(tierForEdge({ top: ["e1"], bottom: [] }, "e2")).toBeUndefined();
    expect(tierForEdge({ top: ["e1"], bottom: [] }, "e1")).toBe("top");
  });
});

describe("withDefaultedEdges / withoutStaleEdges", () => {
  it("appends missing connected edges to the top tier, in the given order", () => {
    const result = withDefaultedEdges({ top: ["e1"], bottom: [] }, ["e1", "e2", "e3"]);
    expect(result).toEqual({ top: ["e1", "e2", "e3"], bottom: [] });
  });

  it("is a no-op when nothing is missing", () => {
    const assignment = { top: ["e1"], bottom: ["e2"] };
    expect(withDefaultedEdges(assignment, ["e1", "e2"])).toEqual(assignment);
  });

  it("drops entries for edges no longer connected", () => {
    const result = withoutStaleEdges({ top: ["e1", "e2"], bottom: ["e3"] }, ["e1", "e3"]);
    expect(result).toEqual({ top: ["e1"], bottom: ["e3"] });
  });
});

describe("setTier / moveWithinTier", () => {
  it("moves an edge from top to bottom, appended at the end", () => {
    const result = setTier({ top: ["e1", "e2"], bottom: ["e3"] }, "e1", "bottom");
    expect(result).toEqual({ top: ["e2"], bottom: ["e3", "e1"] });
  });

  it("moving an edge already in the target tier is idempotent (re-appends at the end)", () => {
    const result = setTier({ top: ["e1", "e2"], bottom: [] }, "e1", "top");
    expect(result).toEqual({ top: ["e2", "e1"], bottom: [] });
  });

  it("swaps two adjacent top-tier entries", () => {
    const result = moveWithinTier({ top: ["e1", "e2", "e3"], bottom: [] }, "e2", "up");
    expect(result).toEqual({ top: ["e2", "e1", "e3"], bottom: [] });
  });

  it("never crosses tiers when reordering", () => {
    const assignment = { top: ["e1", "e2"], bottom: ["e3", "e4"] };
    // e2 is the LAST top entry — "down" would need to reach into bottom, which must not happen.
    expect(moveWithinTier(assignment, "e2", "down")).toEqual(assignment);
  });

  it("is a no-op for an edge with no tier assignment at all", () => {
    const assignment = { top: ["e1"], bottom: [] };
    expect(moveWithinTier(assignment, "e9", "up")).toBe(assignment);
  });
});

describe("computeSplurgerShape", () => {
  it("classifies empty/passthrough/splitter/merger/unsupported correctly", () => {
    expect(computeSplurgerShape("s", []).kind).toBe("empty");
    expect(
      computeSplurgerShape("s", [edge({ id: "e1", toNode: "s" }), edge({ id: "e2", fromNode: "s" })]).kind,
    ).toBe("passthrough");
    expect(
      computeSplurgerShape("s", [
        edge({ id: "e1", toNode: "s" }),
        edge({ id: "e2", fromNode: "s" }),
        edge({ id: "e3", fromNode: "s" }),
      ]).kind,
    ).toBe("splitter");
    expect(
      computeSplurgerShape("s", [
        edge({ id: "e1", toNode: "s" }),
        edge({ id: "e2", toNode: "s" }),
        edge({ id: "e3", fromNode: "s" }),
      ]).kind,
    ).toBe("merger");
    expect(
      computeSplurgerShape("s", [
        edge({ id: "e1", toNode: "s" }),
        edge({ id: "e2", toNode: "s" }),
        edge({ id: "e3", fromNode: "s" }),
        edge({ id: "e4", fromNode: "s" }),
      ]).kind,
    ).toBe("unsupported");
  });

  it("flags a part present on only one side as dangling — nothing to route it to", () => {
    // Both sides carry SOME edge (so the whole-node kind reads as an
    // ordinary passthrough), but they're different parts — neither part
    // actually has a matching opposite side.
    const shape = computeSplurgerShape("s", [
      edge({ id: "e1", toNode: "s", part: "Iron Ore" }),
      edge({ id: "e2", fromNode: "s", part: "Copper Ore" }),
    ]);
    expect(shape.kind).toBe("passthrough");
    expect([...shape.danglingParts].sort()).toEqual(["Copper Ore", "Iron Ore"]);
  });

  it("does not flag a part wired on both sides as dangling", () => {
    const shape = computeSplurgerShape("s", [
      edge({ id: "e1", toNode: "s", part: "Iron Ore" }),
      edge({ id: "e2", fromNode: "s", part: "Iron Ore" }),
    ]);
    expect(shape.danglingParts).toEqual([]);
  });

  it("tierOwningDirection is \"out\" for a splitter, \"in\" for a merger, null otherwise", () => {
    expect(
      computeSplurgerShape("s", [edge({ id: "e1", toNode: "s" }), edge({ id: "e2", fromNode: "s" }), edge({ id: "e3", fromNode: "s" })])
        .tierOwningDirection,
    ).toBe("out");
    expect(
      computeSplurgerShape("s", [edge({ id: "e1", toNode: "s" }), edge({ id: "e2", toNode: "s" }), edge({ id: "e3", fromNode: "s" })])
        .tierOwningDirection,
    ).toBe("in");
    expect(computeSplurgerShape("s", [edge({ id: "e1", toNode: "s" }), edge({ id: "e2", fromNode: "s" })]).tierOwningDirection).toBeNull();
    expect(computeSplurgerShape("s", []).tierOwningDirection).toBeNull();
  });
});

describe("computeSplurgerPassthroughEdges", () => {
  it("rewrites a 1-input/N-output Splurger (splitter) into direct edges carrying the output's own tier", () => {
    const edges: SplurgerEdgeLike[] = [
      edge({ id: "in1", fromNode: "producer", fromPort: "out:Iron Ore", toNode: "s", toPort: "in:*" }),
      edge({ id: "out1", fromNode: "s", fromPort: "out:*", toNode: "consumerA", toPort: "in:Iron Ore" }),
      edge({ id: "out2", fromNode: "s", fromPort: "out:*", toNode: "consumerB", toPort: "in:Iron Ore" }),
    ];
    const splurger = { id: "s", priorityOrder: encodePriorityOrder({ top: ["out1"], bottom: ["out2"] }) };

    const result = computeSplurgerPassthroughEdges([splurger], edges);

    expect(result.unsupportedNodeIds.size).toBe(0);
    expect(result.edges).toHaveLength(2);
    const byTarget = new Map(result.edges.map((e) => [e.toNode, e]));
    expect(byTarget.get("consumerA")).toMatchObject({
      fromNode: "producer",
      fromPort: "out:Iron Ore",
      toNode: "consumerA",
      toPort: "in:Iron Ore",
      part: "Iron Ore",
      priorityTier: "top",
    });
    expect(byTarget.get("consumerB")).toMatchObject({
      fromNode: "producer",
      toNode: "consumerB",
      priorityTier: "bottom",
    });
  });

  it("reads the tier straight off a *top/*bottom port when present, with no priorityOrder needed at all", () => {
    const edges: SplurgerEdgeLike[] = [
      edge({ id: "in1", fromNode: "producer", fromPort: "out:Iron Ore", toNode: "s", toPort: "in:*" }),
      edge({ id: "out1", fromNode: "s", fromPort: "out:*top", toNode: "consumerA", toPort: "in:Iron Ore" }),
      edge({ id: "out2", fromNode: "s", fromPort: "out:*bottom", toNode: "consumerB", toPort: "in:Iron Ore" }),
    ];
    // No priorityOrder at all — the port strings alone determine tier.
    const result = computeSplurgerPassthroughEdges([{ id: "s", priorityOrder: [] }], edges);
    const byTarget = new Map(result.edges.map((e) => [e.toNode, e]));
    expect(byTarget.get("consumerA")?.priorityTier).toBe("top");
    expect(byTarget.get("consumerB")?.priorityTier).toBe("bottom");
  });

  it("prefers a *top/*bottom port over a conflicting priorityOrder assignment", () => {
    const edges: SplurgerEdgeLike[] = [
      edge({ id: "in1", fromNode: "producer", toNode: "s", toPort: "in:*" }),
      edge({ id: "out1", fromNode: "s", fromPort: "out:*bottom", toNode: "consumer", toPort: "in:Iron Ore" }),
    ];
    // priorityOrder says "top", but the port itself says "bottom" — the port wins.
    const splurger = { id: "s", priorityOrder: encodePriorityOrder({ top: ["out1"], bottom: [] }) };
    const result = computeSplurgerPassthroughEdges([splurger], edges);
    expect(result.edges[0]!.priorityTier).toBe("bottom");
  });

  it("rewrites an N-input/1-output Splurger (merger) into direct edges carrying the input's own tier", () => {
    const edges: SplurgerEdgeLike[] = [
      edge({ id: "in1", fromNode: "producerA", fromPort: "out:Iron Ore", toNode: "s", toPort: "in:*" }),
      edge({ id: "in2", fromNode: "producerB", fromPort: "out:Iron Ore", toNode: "s", toPort: "in:*" }),
      edge({ id: "out1", fromNode: "s", fromPort: "out:*", toNode: "consumer", toPort: "in:Iron Ore" }),
    ];
    const splurger = { id: "s", priorityOrder: encodePriorityOrder({ top: ["in1"], bottom: ["in2"] }) };

    const result = computeSplurgerPassthroughEdges([splurger], edges);

    expect(result.edges).toHaveLength(2);
    const byFrom = new Map(result.edges.map((e) => [e.fromNode, e]));
    expect(byFrom.get("producerA")).toMatchObject({ toNode: "consumer", priorityTier: "top" });
    expect(byFrom.get("producerB")).toMatchObject({ toNode: "consumer", priorityTier: "bottom" });
  });

  it("defaults an unassigned edge's tier to undefined (behaves as top per @scm/solver's convention)", () => {
    const edges: SplurgerEdgeLike[] = [
      edge({ id: "in1", fromNode: "producer", toNode: "s" }),
      edge({ id: "out1", fromNode: "s", toNode: "consumer" }),
    ];
    const result = computeSplurgerPassthroughEdges([{ id: "s", priorityOrder: [] }], edges);
    expect(result.edges[0]!.priorityTier).toBeUndefined();
  });

  it("produces no synthetic edge for a part dangling on one side (no input, or no output)", () => {
    const edges: SplurgerEdgeLike[] = [edge({ id: "in1", fromNode: "producer", toNode: "s" })];
    const result = computeSplurgerPassthroughEdges([{ id: "s", priorityOrder: [] }], edges);
    expect(result.edges).toHaveLength(0);
    expect(result.unsupportedNodeIds.size).toBe(0);
  });

  it("excludes a multi-input/multi-output part-group and reports the node id, rather than guessing at a crossbar", () => {
    const edges: SplurgerEdgeLike[] = [
      edge({ id: "in1", fromNode: "producerA", toNode: "s" }),
      edge({ id: "in2", fromNode: "producerB", toNode: "s" }),
      edge({ id: "out1", fromNode: "s", toNode: "consumerA" }),
      edge({ id: "out2", fromNode: "s", toNode: "consumerB" }),
    ];
    const result = computeSplurgerPassthroughEdges([{ id: "s", priorityOrder: [] }], edges);
    expect(result.edges).toHaveLength(0);
    expect(result.unsupportedNodeIds.has("s")).toBe(true);
  });

  it("treats two different parts through the same Splurger as independent routing decisions", () => {
    const edges: SplurgerEdgeLike[] = [
      edge({ id: "ironIn", part: "Iron Ore", fromNode: "ironProducer", toNode: "s" }),
      edge({ id: "ironOut", part: "Iron Ore", fromNode: "s", toNode: "ironConsumer" }),
      edge({ id: "copperIn", part: "Copper Ore", fromNode: "copperProducer", toNode: "s" }),
      edge({ id: "copperOut1", part: "Copper Ore", fromNode: "s", toNode: "copperConsumerA" }),
      edge({ id: "copperOut2", part: "Copper Ore", fromNode: "s", toNode: "copperConsumerB" }),
    ];
    const result = computeSplurgerPassthroughEdges([{ id: "s", priorityOrder: [] }], edges);
    expect(result.unsupportedNodeIds.size).toBe(0);
    expect(result.edges).toHaveLength(3);
    expect(result.edges.find((e) => e.part === "Iron Ore")).toMatchObject({
      fromNode: "ironProducer",
      toNode: "ironConsumer",
    });
    expect(result.edges.filter((e) => e.part === "Copper Ore")).toHaveLength(2);
  });

  it("produces synthetic edge ids that are deterministic and stable regardless of input array order", () => {
    const edges: SplurgerEdgeLike[] = [
      edge({ id: "in1", fromNode: "producer", toNode: "s" }),
      edge({ id: "out1", fromNode: "s", toNode: "consumer" }),
    ];
    const a = computeSplurgerPassthroughEdges([{ id: "s", priorityOrder: [] }], edges);
    const b = computeSplurgerPassthroughEdges([{ id: "s", priorityOrder: [] }], [...edges].reverse());
    expect(a.edges[0]!.id).toBe(b.edges[0]!.id);
  });

  it("ignores a Splurger with no incident edges at all", () => {
    const result = computeSplurgerPassthroughEdges([{ id: "lonely", priorityOrder: [] }], []);
    expect(result.edges).toHaveLength(0);
    expect(result.unsupportedNodeIds.size).toBe(0);
  });
});

describe("tierGroupsForCaps", () => {
  it("is true only for a side capped at 2, regardless of the other side", () => {
    expect(tierGroupsForCaps({ in: 1, out: 1 })).toEqual({ in: false, out: false });
    expect(tierGroupsForCaps({ in: 1, out: 2 })).toEqual({ in: false, out: true });
    expect(tierGroupsForCaps({ in: 2, out: 1 })).toEqual({ in: true, out: false });
    expect(tierGroupsForCaps({ in: 2, out: 2 })).toEqual({ in: true, out: true });
  });
});
