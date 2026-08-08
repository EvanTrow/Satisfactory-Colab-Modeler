import { describe, expect, it } from "vitest";

import { computeSinkConsumerNodes, sinkConsumerNodeId, type SinkEdgeLike, type SinkNodeLike } from "./sinkPassthrough";

function sink(overrides: Partial<SinkNodeLike> & { id: string }): SinkNodeLike {
  return { limit: null, limitMode: "ppm", ...overrides };
}

function edge(overrides: Partial<SinkEdgeLike> & { id: string }): SinkEdgeLike {
  return { part: "Iron Ore", fromNode: "producer", fromPort: "out:Iron Ore", toNode: "sink1", toPort: "in:*", ...overrides };
}

describe("computeSinkConsumerNodes", () => {
  it("produces nothing for a sink with no incident edges", () => {
    const result = computeSinkConsumerNodes([sink({ id: "sink1" })], []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("synthesizes one single-part consumer node carrying the sink's own limit/limitMode", () => {
    const result = computeSinkConsumerNodes(
      [sink({ id: "sink1", limit: "500", limitMode: "ppm" })],
      [edge({ id: "e1" })],
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: sinkConsumerNodeId("sink1", "Iron Ore"),
      limit: "500",
      limitMode: "ppm",
      blueprintCopyBasis: { perCopyRates: { "Iron Ore": "-1" }, perCopyPowerMW: 0 },
    });
    expect(result.edges).toEqual([
      {
        id: "sk-e:e1",
        part: "Iron Ore",
        fromNode: "producer",
        fromPort: "out:Iron Ore",
        toNode: sinkConsumerNodeId("sink1", "Iron Ore"),
        toPort: "in:Iron Ore",
      },
    ]);
  });

  it("groups multiple producers of the SAME part into one shared consumer node", () => {
    const result = computeSinkConsumerNodes(
      [sink({ id: "sink1" })],
      [edge({ id: "e1", fromNode: "p1" }), edge({ id: "e2", fromNode: "p2" })],
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.every((e) => e.toNode === sinkConsumerNodeId("sink1", "Iron Ore"))).toBe(true);
  });

  it("gives each DISTINCT part its own independent consumer node", () => {
    const result = computeSinkConsumerNodes(
      [sink({ id: "sink1" })],
      [edge({ id: "e1", part: "Iron Ore" }), edge({ id: "e2", part: "Copper Ore" })],
    );
    expect(result.nodes).toHaveLength(2);
    const ids = result.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([sinkConsumerNodeId("sink1", "Copper Ore"), sinkConsumerNodeId("sink1", "Iron Ore")].sort());
  });

  it("handles multiple sinks independently", () => {
    const result = computeSinkConsumerNodes(
      [sink({ id: "sink1" }), sink({ id: "sink2" })],
      [edge({ id: "e1", toNode: "sink1" }), edge({ id: "e2", toNode: "sink2" })],
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.edges.map((e) => e.toNode).sort()).toEqual(
      [sinkConsumerNodeId("sink1", "Iron Ore"), sinkConsumerNodeId("sink2", "Iron Ore")].sort(),
    );
  });
});
