import { addContainer, addNode, addWaypoint, createDocument, getEdge, listEdges, moveNode, type SfmDocument } from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import {
  WILDCARD_PART,
  connectPorts,
  isValidPortConnection,
  parsePortHandleId,
  reconnectEdge,
  resolveEdgeEndpoints,
} from "./connectionLogic";

function makeDoc(): { sfmDoc: SfmDocument; containerId: string; nodeA: string; nodeB: string; nodeC: string } {
  const sfmDoc = createDocument();
  const root = addContainer(sfmDoc, {
    kind: "root",
    parentId: null,
    title: "Root",
    color: "#4b5563",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  const baseNode = {
    containerId: root.id,
    kind: "recipe",
    recipe: null,
    machine: null,
    y: 0,
    title: "",
    color: "#4b5563",
    limit: null,
    limitMode: "machines" as const,
    clock: null,
    autoRound: false,
    shards: 0,
    purity: null,
    beltTier: null,
    storageMode: null,
  };
  const nodeA = addNode(sfmDoc, { ...baseNode, x: 0, title: "A" });
  const nodeB = addNode(sfmDoc, { ...baseNode, x: 200, title: "B" });
  const nodeC = addNode(sfmDoc, { ...baseNode, x: 400, title: "C" });
  return { sfmDoc, containerId: root.id, nodeA: nodeA.id, nodeB: nodeB.id, nodeC: nodeC.id };
}

describe("parsePortHandleId", () => {
  it("parses an output handle", () => {
    expect(parsePortHandleId("out:Iron Plate")).toEqual({ direction: "out", part: "Iron Plate" });
  });

  it("parses an input handle", () => {
    expect(parsePortHandleId("in:Iron Ingot")).toEqual({ direction: "in", part: "Iron Ingot" });
  });

  it("rejects null/undefined", () => {
    expect(parsePortHandleId(null)).toBeNull();
    expect(parsePortHandleId(undefined)).toBeNull();
  });

  it("rejects a handle id with no prefix", () => {
    expect(parsePortHandleId("Iron Plate")).toBeNull();
  });

  it("rejects an unknown direction prefix", () => {
    expect(parsePortHandleId("through:Iron Plate")).toBeNull();
  });

  it("rejects an empty part name", () => {
    expect(parsePortHandleId("out:")).toBeNull();
  });
});

describe("resolveEdgeEndpoints", () => {
  it("resolves a plain output -> input drag", () => {
    const resolved = resolveEdgeEndpoints({
      source: "n1",
      sourceHandle: "out:Iron Plate",
      target: "n2",
      targetHandle: "in:Iron Plate",
    });
    expect(resolved).toEqual({ fromNode: "n1", fromPort: "out:Iron Plate", toNode: "n2", toPort: "in:Iron Plate", part: "Iron Plate" });
  });

  it("resolves an input -> output drag to the same fromNode/toNode as the reverse direction (both directions work)", () => {
    // Physically dragged from the input handle first this time.
    const resolved = resolveEdgeEndpoints({
      source: "n2",
      sourceHandle: "in:Iron Plate",
      target: "n1",
      targetHandle: "out:Iron Plate",
    });
    // Same logical edge as the "plain" case above: output side is always `from`.
    expect(resolved).toEqual({ fromNode: "n1", fromPort: "out:Iron Plate", toNode: "n2", toPort: "in:Iron Plate", part: "Iron Plate" });
  });

  it("rejects mismatched parts", () => {
    expect(
      resolveEdgeEndpoints({ source: "n1", sourceHandle: "out:Iron Ore", target: "n2", targetHandle: "in:Iron Ingot" }),
    ).toBeNull();
  });

  it("rejects two outputs", () => {
    expect(
      resolveEdgeEndpoints({ source: "n1", sourceHandle: "out:Iron Plate", target: "n2", targetHandle: "out:Iron Plate" }),
    ).toBeNull();
  });

  it("rejects two inputs", () => {
    expect(
      resolveEdgeEndpoints({ source: "n1", sourceHandle: "in:Iron Plate", target: "n2", targetHandle: "in:Iron Plate" }),
    ).toBeNull();
  });

  it("rejects a missing handle id", () => {
    expect(resolveEdgeEndpoints({ source: "n1", sourceHandle: null, target: "n2", targetHandle: "in:Iron Plate" })).toBeNull();
  });

  it("rejects a missing node id", () => {
    expect(
      resolveEdgeEndpoints({ source: null, sourceHandle: "out:Iron Plate", target: "n2", targetHandle: "in:Iron Plate" }),
    ).toBeNull();
  });

  // Job 024: a Splurger's generic `in:*`/`out:*` handles (no fixed recipe,
  // so no fixed part list) defer to whichever real part is on the other
  // end — see `WILDCARD_PART`'s doc comment.
  it("resolves a wildcard output handle against a concrete input part", () => {
    const resolved = resolveEdgeEndpoints({
      source: "splurger1",
      sourceHandle: `out:${WILDCARD_PART}`,
      target: "n2",
      targetHandle: "in:Iron Plate",
    });
    expect(resolved).toEqual({
      fromNode: "splurger1",
      fromPort: `out:${WILDCARD_PART}`,
      toNode: "n2",
      toPort: "in:Iron Plate",
      part: "Iron Plate",
    });
  });

  it("resolves a concrete output part against a wildcard input handle", () => {
    const resolved = resolveEdgeEndpoints({
      source: "n1",
      sourceHandle: "out:Iron Plate",
      target: "splurger1",
      targetHandle: `in:${WILDCARD_PART}`,
    });
    expect(resolved).toEqual({
      fromNode: "n1",
      fromPort: "out:Iron Plate",
      toNode: "splurger1",
      toPort: `in:${WILDCARD_PART}`,
      part: "Iron Plate",
    });
  });

  it("rejects two wildcard handles (no real part to assign — Splurger-to-Splurger chaining isn't a supported shape)", () => {
    expect(
      resolveEdgeEndpoints({
        source: "splurger1",
        sourceHandle: `out:${WILDCARD_PART}`,
        target: "splurger2",
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBeNull();
  });
});

describe("isValidPortConnection", () => {
  it("mirrors resolveEdgeEndpoints's accept/reject decision", () => {
    expect(
      isValidPortConnection({ source: "n1", sourceHandle: "out:Iron Plate", target: "n2", targetHandle: "in:Iron Plate" }),
    ).toBe(true);
    expect(
      isValidPortConnection({ source: "n1", sourceHandle: "out:Iron Ore", target: "n2", targetHandle: "in:Iron Ingot" }),
    ).toBe(false);
  });
});

describe("connectPorts", () => {
  it("creates an edge with the correct fields", () => {
    const { sfmDoc, containerId, nodeA, nodeB } = makeDoc();
    const edge = connectPorts(sfmDoc, containerId, {
      source: nodeA,
      sourceHandle: "out:Iron Ore",
      target: nodeB,
      targetHandle: "in:Iron Ore",
    });
    expect(edge).not.toBeNull();
    expect(edge).toMatchObject({
      containerId,
      part: "Iron Ore",
      fromNode: nodeA,
      fromPort: "out:Iron Ore",
      toNode: nodeB,
      toPort: "in:Iron Ore",
      waypoints: [],
    });
  });

  it("is a no-op for a mismatched-part connection (rejects, no edge created)", () => {
    const { sfmDoc, containerId, nodeA, nodeB } = makeDoc();
    const result = connectPorts(sfmDoc, containerId, {
      source: nodeA,
      sourceHandle: "out:Iron Ore",
      target: nodeB,
      targetHandle: "in:Iron Ingot",
    });
    expect(result).toBeNull();
    expect(listEdges(sfmDoc)).toHaveLength(0);
  });

  it("dragging the same two ports a second time removes the connection instead of duplicating it (toggle)", () => {
    const { sfmDoc, containerId, nodeA, nodeB } = makeDoc();
    const connection = { source: nodeA, sourceHandle: "out:Iron Ore", target: nodeB, targetHandle: "in:Iron Ore" };
    const first = connectPorts(sfmDoc, containerId, connection);
    expect(first).not.toBeNull();
    expect(listEdges(sfmDoc)).toHaveLength(1);

    const second = connectPorts(sfmDoc, containerId, connection);
    expect(second).toBeNull();
    expect(getEdge(sfmDoc, first!.id)).toBeUndefined();
    expect(listEdges(sfmDoc)).toHaveLength(0);

    // A third drag reconnects — the toggle isn't one-way.
    const third = connectPorts(sfmDoc, containerId, connection);
    expect(third).not.toBeNull();
    expect(third!.id).toBe(first!.id);
    expect(listEdges(sfmDoc)).toHaveLength(1);
  });

  it("toggling off via the reverse drag direction still removes the edge (same deterministic id either way)", () => {
    const { sfmDoc, containerId, nodeA, nodeB } = makeDoc();
    const forward = connectPorts(sfmDoc, containerId, {
      source: nodeA,
      sourceHandle: "out:Iron Ore",
      target: nodeB,
      targetHandle: "in:Iron Ore",
    });
    expect(forward).not.toBeNull();

    const reverseToggleOff = connectPorts(sfmDoc, containerId, {
      source: nodeB,
      sourceHandle: "in:Iron Ore",
      target: nodeA,
      targetHandle: "out:Iron Ore",
    });
    expect(reverseToggleOff).toBeNull();
    expect(listEdges(sfmDoc)).toHaveLength(0);
  });

  it("connecting via the reverse drag direction produces the exact same edge id as the forward direction", () => {
    const { sfmDoc, containerId, nodeA, nodeB } = makeDoc();
    const forward = connectPorts(sfmDoc, containerId, {
      source: nodeA,
      sourceHandle: "out:Iron Ore",
      target: nodeB,
      targetHandle: "in:Iron Ore",
    });
    // A second, independent doc: same two ports, but the user dragged from the input handle this time.
    const { sfmDoc: sfmDoc2, containerId: containerId2 } = makeDoc();
    const reverse = connectPorts(sfmDoc2, containerId2, {
      source: nodeB,
      sourceHandle: "in:Iron Ore",
      target: nodeA,
      targetHandle: "out:Iron Ore",
    });
    expect(forward!.id).toBe(reverse!.id);
    expect(forward).toMatchObject({ fromNode: nodeA, toNode: nodeB });
    expect(reverse).toMatchObject({ fromNode: nodeA, toNode: nodeB });
  });
});

describe("reconnectEdge", () => {
  it("removes the old edge and creates a new one at the new endpoint, preserving waypoints", () => {
    const { sfmDoc, containerId, nodeA, nodeB, nodeC } = makeDoc();
    const original = connectPorts(sfmDoc, containerId, {
      source: nodeA,
      sourceHandle: "out:Iron Ore",
      target: nodeB,
      targetHandle: "in:Iron Ore",
    })!;
    const waypoints = [{ x: 10, y: 20 }];

    const reconnected = reconnectEdge(
      sfmDoc,
      containerId,
      original.id,
      { source: nodeA, sourceHandle: "out:Iron Ore", target: nodeC, targetHandle: "in:Iron Ore" },
      waypoints,
    );

    expect(getEdge(sfmDoc, original.id)).toBeUndefined();
    expect(reconnected).toMatchObject({ fromNode: nodeA, toNode: nodeC, waypoints });
    expect(listEdges(sfmDoc)).toHaveLength(1);
  });

  it("leaves the old edge untouched if the new connection doesn't resolve (mismatched parts)", () => {
    const { sfmDoc, containerId, nodeA, nodeB, nodeC } = makeDoc();
    const original = connectPorts(sfmDoc, containerId, {
      source: nodeA,
      sourceHandle: "out:Iron Ore",
      target: nodeB,
      targetHandle: "in:Iron Ore",
    })!;

    const result = reconnectEdge(sfmDoc, containerId, original.id, {
      source: nodeA,
      sourceHandle: "out:Iron Ore",
      target: nodeC,
      targetHandle: "in:Iron Ingot",
    });

    expect(result).toBeNull();
    expect(getEdge(sfmDoc, original.id)).toBeDefined();
    expect(listEdges(sfmDoc)).toHaveLength(1);
  });
});

describe("waypoint persistence across an endpoint node drag", () => {
  it("leaves an edge's absolute waypoint coordinates unchanged when either endpoint node moves", () => {
    const { sfmDoc, containerId, nodeA, nodeB } = makeDoc();
    const edge = connectPorts(sfmDoc, containerId, {
      source: nodeA,
      sourceHandle: "out:Iron Ore",
      target: nodeB,
      targetHandle: "in:Iron Ore",
    })!;

    addWaypoint(sfmDoc, edge.id, { x: 123, y: -45 });

    moveNode(sfmDoc, nodeA, 9999, -9999);
    moveNode(sfmDoc, nodeB, -1234, 5678);

    expect(getEdge(sfmDoc, edge.id)?.waypoints).toEqual([{ x: 123, y: -45 }]);
  });
});
