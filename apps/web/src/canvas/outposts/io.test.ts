import { describe, expect, it } from "vitest";

import type { EdgeRecord } from "@scm/ydoc";

import { computeIoUnsupportedParts } from "./io";

function edge(overrides: Partial<EdgeRecord> & Pick<EdgeRecord, "id" | "part" | "fromNode" | "toNode">): EdgeRecord {
  return {
    containerId: "outpost:1",
    fromPort: "*",
    toPort: "*",
    waypoints: [],
    style: null,
    labelPos: null,
    ...overrides,
  };
}

describe("computeIoUnsupportedParts", () => {
  it("does not flag two different parts each wired 1 external -> 1 internal", () => {
    const ioNodeId = "io-in:outpost:1";
    const edges: EdgeRecord[] = [
      edge({ id: "e1", part: "Alclad Aluminum Sheet", fromNode: "ext-alclad", toNode: ioNodeId }),
      edge({ id: "e2", part: "Alclad Aluminum Sheet", fromNode: ioNodeId, toNode: "heat-sink" }),
      edge({ id: "e3", part: "Copper Sheet", fromNode: "ext-copper", toNode: ioNodeId }),
      edge({ id: "e4", part: "Copper Sheet", fromNode: ioNodeId, toNode: "heat-sink" }),
    ];

    expect(computeIoUnsupportedParts(edges, ioNodeId, "out")).toEqual(new Set());
  });

  it("flags a single part wired with multiple sources AND multiple destinations", () => {
    const ioNodeId = "io-in:outpost:1";
    const edges: EdgeRecord[] = [
      edge({ id: "e1", part: "Iron Plate", fromNode: "ext-a", toNode: ioNodeId }),
      edge({ id: "e2", part: "Iron Plate", fromNode: "ext-b", toNode: ioNodeId }),
      edge({ id: "e3", part: "Iron Plate", fromNode: ioNodeId, toNode: "recipe-a" }),
      edge({ id: "e4", part: "Iron Plate", fromNode: ioNodeId, toNode: "recipe-b" }),
    ];

    expect(computeIoUnsupportedParts(edges, ioNodeId, "out")).toEqual(new Set(["Iron Plate"]));
  });

  it("does not flag multiple internal edges for one part with only a single external source", () => {
    const ioNodeId = "io-in:outpost:1";
    const edges: EdgeRecord[] = [
      edge({ id: "e1", part: "Iron Plate", fromNode: "ext-a", toNode: ioNodeId }),
      edge({ id: "e2", part: "Iron Plate", fromNode: ioNodeId, toNode: "recipe-a" }),
      edge({ id: "e3", part: "Iron Plate", fromNode: ioNodeId, toNode: "recipe-b" }),
    ];

    expect(computeIoUnsupportedParts(edges, ioNodeId, "out")).toEqual(new Set());
  });
});
