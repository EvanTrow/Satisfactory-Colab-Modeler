import { describe, expect, it } from "vitest";

import {
  computeStorageBufferNodes,
  storageConsumerNodeId,
  storageProducerNodeId,
  type StorageEdgeLike,
  type StorageNodeLike,
} from "./storagePassthrough";

function edge(overrides: Partial<StorageEdgeLike> & { id: string }): StorageEdgeLike {
  return { part: "Iron Ore", fromNode: "a", fromPort: "out:Iron Ore", toNode: "b", toPort: "in:Iron Ore", ...overrides };
}

const storage1: StorageNodeLike = { id: "storage1" };

describe("computeStorageBufferNodes", () => {
  it("produces nothing for a storage node with no incident edges", () => {
    const result = computeStorageBufferNodes([storage1], []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.multiPartNodeIds.size).toBe(0);
  });

  it("synthesizes an uncapped consumer for an incoming edge", () => {
    const result = computeStorageBufferNodes([storage1], [edge({ id: "e1", toNode: "storage1", fromNode: "producer" })]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: storageConsumerNodeId("storage1", "Iron Ore"),
      limit: null,
      blueprintCopyBasis: { perCopyRates: { "Iron Ore": "-1" }, perCopyPowerMW: 0 },
    });
    expect(result.edges).toEqual([
      {
        id: "stg-e:e1",
        part: "Iron Ore",
        fromNode: "producer",
        fromPort: "out:Iron Ore",
        toNode: storageConsumerNodeId("storage1", "Iron Ore"),
        toPort: "in:Iron Ore",
      },
    ]);
  });

  it("synthesizes an uncapped producer for an outgoing edge", () => {
    const result = computeStorageBufferNodes([storage1], [edge({ id: "e1", fromNode: "storage1", toNode: "consumer" })]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: storageProducerNodeId("storage1", "Iron Ore"),
      limit: null,
      blueprintCopyBasis: { perCopyRates: { "Iron Ore": "1" }, perCopyPowerMW: 0 },
    });
    expect(result.edges).toEqual([
      {
        id: "stg-e:e1",
        part: "Iron Ore",
        fromNode: storageProducerNodeId("storage1", "Iron Ore"),
        fromPort: "out:Iron Ore",
        toNode: "consumer",
        toPort: "in:Iron Ore",
      },
    ]);
  });

  it("handles decoupled in/out — an unbalanced in vs out is not an error at this layer", () => {
    const result = computeStorageBufferNodes(
      [storage1],
      [
        edge({ id: "in1", toNode: "storage1", fromNode: "producer" }),
        edge({ id: "out1", fromNode: "storage1", toNode: "consumerA" }),
        edge({ id: "out2", fromNode: "storage1", toNode: "consumerB" }),
      ],
    );
    // One consumer node (the shared input side) + one producer node (the shared output side, both consumers pull from it).
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(3);
    expect(result.multiPartNodeIds.size).toBe(0);
  });

  it("flags a storage node touching more than one distinct part via multiPartNodeIds", () => {
    const result = computeStorageBufferNodes(
      [storage1],
      [
        edge({ id: "e1", part: "Iron Ore", toNode: "storage1" }),
        edge({ id: "e2", part: "Copper Ore", fromNode: "storage1", toNode: "consumer" }),
      ],
    );
    expect(result.multiPartNodeIds.has("storage1")).toBe(true);
    expect(result.nodes).toHaveLength(2);
  });

  it("keeps multiple storage nodes independent", () => {
    const storage2: StorageNodeLike = { id: "storage2" };
    const result = computeStorageBufferNodes(
      [storage1, storage2],
      [edge({ id: "e1", toNode: "storage1" }), edge({ id: "e2", toNode: "storage2" })],
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.multiPartNodeIds.size).toBe(0);
  });
});
