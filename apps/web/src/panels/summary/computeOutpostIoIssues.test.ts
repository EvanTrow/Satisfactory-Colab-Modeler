import type { EdgeRecord, NodeRecord } from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { OUTPOST_INPUT_KIND, OUTPOST_OUTPUT_KIND, outpostInputNodeId, outpostOutputNodeId } from "../../canvas/outposts/io";
import { computeOutpostIoIssues } from "./computeOutpostIoIssues";

function node(overrides: Partial<NodeRecord> & Pick<NodeRecord, "id" | "kind">): NodeRecord {
  return {
    containerId: "outpost:1",
    recipe: null,
    machine: null,
    x: 0,
    y: 0,
    title: "",
    color: "#fff",
    limit: null,
    limitMode: "machines",
    clock: null,
    autoRound: true,
    shards: 0,
    purity: null,
    beltTier: null,
    storageMode: null,
    splitterVariant: null,
    mergerVariant: null,
    priorityOrder: [],
    ...overrides,
  };
}

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

const nodeDisplayName = (n: NodeRecord) => n.title || n.id;

describe("computeOutpostIoIssues", () => {
  it("returns [] when an outpost's Inputs/Outputs nodes are fully wired", () => {
    const inputId = outpostInputNodeId("outpost:1");
    const nodes = [node({ id: inputId, kind: OUTPOST_INPUT_KIND, title: "Inputs" })];
    const edges = [
      edge({ id: "e1", part: "Iron Plate", fromNode: "ext", toNode: inputId }),
      edge({ id: "e2", part: "Iron Plate", fromNode: inputId, toNode: "recipe-a" }),
    ];
    expect(computeOutpostIoIssues(nodes, edges, nodeDisplayName)).toEqual([]);
  });

  it("ignores nodes that aren't outpost Inputs/Outputs nodes", () => {
    const nodes = [node({ id: "recipe-a", kind: "recipe", title: "Smelter" })];
    const edges = [edge({ id: "e1", part: "Iron Plate", fromNode: "ext", toNode: "recipe-a" })];
    expect(computeOutpostIoIssues(nodes, edges, nodeDisplayName)).toEqual([]);
  });

  it("flags a dangling part wired on only one side of the Inputs node", () => {
    const inputId = outpostInputNodeId("outpost:1");
    const nodes = [node({ id: inputId, kind: OUTPOST_INPUT_KIND, title: "Inputs" })];
    const edges = [edge({ id: "e1", part: "Iron Plate", fromNode: "ext", toNode: inputId })];

    const result = computeOutpostIoIssues(nodes, edges, nodeDisplayName);
    expect(result).toEqual([
      {
        key: `outpost-io:${inputId}`,
        severity: "invalid",
        label: "Inputs",
        message: "Iron Plate wired on only one side — connect the other side or remove it.",
        navigateNodeIds: [inputId],
      },
    ]);
  });

  it("flags an unsupported multi-source/multi-destination part on the Outputs node", () => {
    const outputId = outpostOutputNodeId("outpost:1");
    const nodes = [node({ id: outputId, kind: OUTPOST_OUTPUT_KIND, title: "Outputs" })];
    // Outputs node: internal-facing side is "in" (fed by internal producers).
    const edges = [
      edge({ id: "e1", part: "Iron Plate", fromNode: "recipe-a", toNode: outputId }),
      edge({ id: "e2", part: "Iron Plate", fromNode: "recipe-b", toNode: outputId }),
      edge({ id: "e3", part: "Iron Plate", fromNode: outputId, toNode: "ext-a" }),
      edge({ id: "e4", part: "Iron Plate", fromNode: outputId, toNode: "ext-b" }),
    ];

    const result = computeOutpostIoIssues(nodes, edges, nodeDisplayName);
    expect(result).toEqual([
      {
        key: `outpost-io:${outputId}`,
        severity: "invalid",
        label: "Outputs",
        message:
          "Iron Plate: multiple sources and multiple destinations for the same item isn't supported here.",
        navigateNodeIds: [outputId],
      },
    ]);
  });

  it("combines both warnings into one entry when a node has both", () => {
    const inputId = outpostInputNodeId("outpost:1");
    const nodes = [node({ id: inputId, kind: OUTPOST_INPUT_KIND, title: "Inputs" })];
    const edges = [
      // Copper Sheet: dangling (external only, no internal route).
      edge({ id: "e1", part: "Copper Sheet", fromNode: "ext", toNode: inputId }),
      // Iron Plate: unsupported (2 external sources, 2 internal destinations).
      edge({ id: "e2", part: "Iron Plate", fromNode: "ext-a", toNode: inputId }),
      edge({ id: "e3", part: "Iron Plate", fromNode: "ext-b", toNode: inputId }),
      edge({ id: "e4", part: "Iron Plate", fromNode: inputId, toNode: "recipe-a" }),
      edge({ id: "e5", part: "Iron Plate", fromNode: inputId, toNode: "recipe-b" }),
    ];

    const result = computeOutpostIoIssues(nodes, edges, nodeDisplayName);
    expect(result).toHaveLength(1);
    expect(result[0]!.message).toContain("multiple sources and multiple destinations");
    expect(result[0]!.message).toContain("Copper Sheet wired on only one side");
  });
});
