import { addContainer, addNode, addWaypoint, createDocument, getEdge, listEdges, moveNode, type SfmDocument } from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { ensureOutpostIoNodes, outpostInputNodeId, outpostOutputNodeId } from "../outposts/io";
import {
  WILDCARD_PART,
  WILDCARD_PART_BOTTOM,
  WILDCARD_PART_TOP,
  connectPorts,
  isValidDragCandidate,
  isValidPortConnection,
  isWildcardPart,
  parsePortHandleId,
  reconnectEdge,
  resolveEdgeEndpoints,
  storageNodePart,
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
    splurgerVariant: null,
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

// Shared across every describe block below that only ever resolves
// connections between fake/nonexistent node ids ("n1", "splurger1", etc.) —
// `isDepotConnectionAllowed`/`isStorageConnectionAllowed`'s `getNode`/
// `listEdges` lookups simply find nothing for an id never written to this
// doc and fall through to "allowed", so a single never-mutated doc is safe
// to reuse across all of them (real depot/storage-specific behavior gets its
// own dedicated docs further down).
const pureLogicDoc = createDocument();

describe("resolveEdgeEndpoints", () => {
  it("resolves a plain output -> input drag", () => {
    const resolved = resolveEdgeEndpoints(pureLogicDoc, {
      source: "n1",
      sourceHandle: "out:Iron Plate",
      target: "n2",
      targetHandle: "in:Iron Plate",
    });
    expect(resolved).toEqual({ fromNode: "n1", fromPort: "out:Iron Plate", toNode: "n2", toPort: "in:Iron Plate", part: "Iron Plate" });
  });

  it("resolves an input -> output drag to the same fromNode/toNode as the reverse direction (both directions work)", () => {
    // Physically dragged from the input handle first this time.
    const resolved = resolveEdgeEndpoints(pureLogicDoc, {
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
      resolveEdgeEndpoints(pureLogicDoc, { source: "n1", sourceHandle: "out:Iron Ore", target: "n2", targetHandle: "in:Iron Ingot" }),
    ).toBeNull();
  });

  it("rejects two outputs", () => {
    expect(
      resolveEdgeEndpoints(pureLogicDoc, { source: "n1", sourceHandle: "out:Iron Plate", target: "n2", targetHandle: "out:Iron Plate" }),
    ).toBeNull();
  });

  it("rejects two inputs", () => {
    expect(
      resolveEdgeEndpoints(pureLogicDoc, { source: "n1", sourceHandle: "in:Iron Plate", target: "n2", targetHandle: "in:Iron Plate" }),
    ).toBeNull();
  });

  it("rejects a missing handle id", () => {
    expect(resolveEdgeEndpoints(pureLogicDoc, { source: "n1", sourceHandle: null, target: "n2", targetHandle: "in:Iron Plate" })).toBeNull();
  });

  it("rejects a missing node id", () => {
    expect(
      resolveEdgeEndpoints(pureLogicDoc, { source: null, sourceHandle: "out:Iron Plate", target: "n2", targetHandle: "in:Iron Plate" }),
    ).toBeNull();
  });

  // Job 024: a Splurger's generic `in:*`/`out:*` handles (no fixed recipe,
  // so no fixed part list) defer to whichever real part is on the other
  // end — see `WILDCARD_PART`'s doc comment.
  it("resolves a wildcard output handle against a concrete input part", () => {
    const resolved = resolveEdgeEndpoints(pureLogicDoc, {
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
    const resolved = resolveEdgeEndpoints(pureLogicDoc, {
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
      resolveEdgeEndpoints(pureLogicDoc, {
        source: "splurger1",
        sourceHandle: `out:${WILDCARD_PART}`,
        target: "splurger2",
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBeNull();
  });

  // Later Splurger redesign: a tiered side's two real handles (`*top`/
  // `*bottom` — `WILDCARD_PART_TOP`/`WILDCARD_PART_BOTTOM`) are wildcards
  // too, just individually addressable ones.
  it("resolves a tiered wildcard handle (*top/*bottom) against a concrete part, same as the plain wildcard", () => {
    const top = resolveEdgeEndpoints(pureLogicDoc, {
      source: "splurger1",
      sourceHandle: `out:${WILDCARD_PART_TOP}`,
      target: "n2",
      targetHandle: "in:Iron Plate",
    });
    expect(top).toEqual({
      fromNode: "splurger1",
      fromPort: `out:${WILDCARD_PART_TOP}`,
      toNode: "n2",
      toPort: "in:Iron Plate",
      part: "Iron Plate",
    });

    const bottom = resolveEdgeEndpoints(pureLogicDoc, {
      source: "splurger1",
      sourceHandle: `out:${WILDCARD_PART_BOTTOM}`,
      target: "n2",
      targetHandle: "in:Iron Plate",
    });
    expect(bottom?.fromPort).toBe(`out:${WILDCARD_PART_BOTTOM}`);
  });

  it("rejects two tiered wildcard handles, and a tiered wildcard against a plain wildcard", () => {
    expect(
      resolveEdgeEndpoints(pureLogicDoc, {
        source: "splurger1",
        sourceHandle: `out:${WILDCARD_PART_TOP}`,
        target: "splurger2",
        targetHandle: `in:${WILDCARD_PART_BOTTOM}`,
      }),
    ).toBeNull();
    expect(
      resolveEdgeEndpoints(pureLogicDoc, {
        source: "splurger1",
        sourceHandle: `out:${WILDCARD_PART_TOP}`,
        target: "splurger2",
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBeNull();
  });
});

describe("resolveEdgeEndpoints — outpost/blueprint container redirect", () => {
  function makeOutpostDoc() {
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
    const outpost = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root.id,
      title: "Outpost",
      color: "#d97706",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    ensureOutpostIoNodes(sfmDoc, outpost.id, "#d97706");
    const external = addNode(sfmDoc, {
      containerId: root.id,
      kind: "recipe",
      recipe: null,
      machine: null,
      x: 0,
      y: 0,
      title: "External",
      color: "#4b5563",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });
    return { sfmDoc, outpost, external };
  }

  it("redirects a connection dropped on the outer card's target handle to the container's Inputs node", () => {
    const { sfmDoc, outpost, external } = makeOutpostDoc();
    const resolved = resolveEdgeEndpoints(sfmDoc, {
      source: external.id,
      sourceHandle: "out:Iron Ore",
      target: outpost.id,
      targetHandle: `in:${WILDCARD_PART}`,
    });
    expect(resolved).toEqual({
      fromNode: external.id,
      fromPort: "out:Iron Ore",
      toNode: outpostInputNodeId(outpost.id),
      toPort: `in:${WILDCARD_PART}`,
      part: "Iron Ore",
    });
  });

  it("redirects a connection dragged FROM the outer card's source handle to the container's Outputs node", () => {
    const { sfmDoc, outpost, external } = makeOutpostDoc();
    const resolved = resolveEdgeEndpoints(sfmDoc, {
      source: outpost.id,
      sourceHandle: `out:${WILDCARD_PART}`,
      target: external.id,
      targetHandle: "in:Iron Ingot",
    });
    expect(resolved).toEqual({
      fromNode: outpostOutputNodeId(outpost.id),
      fromPort: `out:${WILDCARD_PART}`,
      toNode: external.id,
      toPort: "in:Iron Ingot",
      part: "Iron Ingot",
    });
  });

  it("leaves an ordinary node id alone (not a container id at all)", () => {
    const { sfmDoc, external } = makeOutpostDoc();
    const resolved = resolveEdgeEndpoints(sfmDoc, {
      source: external.id,
      sourceHandle: "out:Iron Ore",
      target: external.id,
      targetHandle: "in:Iron Ore",
    });
    expect(resolved?.toNode).toBe(external.id);
  });
});

describe("isWildcardPart", () => {
  it("is true for the plain wildcard and both tiered sentinels, false for any real part name", () => {
    expect(isWildcardPart(WILDCARD_PART)).toBe(true);
    expect(isWildcardPart(WILDCARD_PART_TOP)).toBe(true);
    expect(isWildcardPart(WILDCARD_PART_BOTTOM)).toBe(true);
    expect(isWildcardPart("Iron Ore")).toBe(false);
  });
});

describe("isValidPortConnection", () => {
  it("mirrors resolveEdgeEndpoints's accept/reject decision", () => {
    expect(
      isValidPortConnection(pureLogicDoc, { source: "n1", sourceHandle: "out:Iron Plate", target: "n2", targetHandle: "in:Iron Plate" }),
    ).toBe(true);
    expect(
      isValidPortConnection(pureLogicDoc, { source: "n1", sourceHandle: "out:Iron Ore", target: "n2", targetHandle: "in:Iron Ingot" }),
    ).toBe(false);
  });
});

describe("isValidDragCandidate", () => {
  it("accepts a source handle dragged onto a matching-part target handle", () => {
    expect(
      isValidDragCandidate(
        pureLogicDoc,
        { nodeId: "n1", id: "out:Iron Plate", type: "source" },
        { nodeId: "n2", id: "in:Iron Plate", type: "target" },
      ),
    ).toBe(true);
  });

  it("accepts the drag starting from a target handle instead (either direction works)", () => {
    expect(
      isValidDragCandidate(
        pureLogicDoc,
        { nodeId: "n2", id: "in:Iron Plate", type: "target" },
        { nodeId: "n1", id: "out:Iron Plate", type: "source" },
      ),
    ).toBe(true);
  });

  it("rejects a mismatched-part candidate", () => {
    expect(
      isValidDragCandidate(
        pureLogicDoc,
        { nodeId: "n1", id: "out:Iron Ore", type: "source" },
        { nodeId: "n2", id: "in:Iron Ingot", type: "target" },
      ),
    ).toBe(false);
  });

  it("rejects two handles of the same type without even considering their parts", () => {
    expect(
      isValidDragCandidate(
        pureLogicDoc,
        { nodeId: "n1", id: "out:Iron Plate", type: "source" },
        { nodeId: "n2", id: "out:Iron Plate", type: "source" },
      ),
    ).toBe(false);
  });

  it("accepts a wildcard (Splurger) candidate regardless of the dragged part", () => {
    expect(
      isValidDragCandidate(
        pureLogicDoc,
        { nodeId: "n1", id: "out:Iron Plate", type: "source" },
        { nodeId: "splurger1", id: `in:${WILDCARD_PART}`, type: "target" },
      ),
    ).toBe(true);
  });

  it("rejects an unparseable candidate handle id (e.g. an outpost boundary handle)", () => {
    expect(
      isValidDragCandidate(
        pureLogicDoc,
        { nodeId: "n1", id: "out:Iron Plate", type: "source" },
        { nodeId: "outpost1", id: "boundary:e1:in", type: "target" },
      ),
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

describe("Dimensional Depot connection restrictions", () => {
  // Sources are deliberately never-created node ids ("producerA" etc.) —
  // `isDepotConnectionAllowed` only reads the TARGET node's own kind/existing
  // edges, so a real source node is unnecessary for these.
  function makeDepotDoc() {
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
      recipe: null,
      machine: null,
      x: 400,
      y: 0,
      title: "",
      color: "#7c3aed",
      limit: null,
      limitMode: "ppm" as const,
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    };
    const depot = addNode(sfmDoc, { ...baseNode, kind: "depot", title: "Dimensional Depot" });
    const sink = addNode(sfmDoc, { ...baseNode, kind: "sink", title: "AWESOME Sink" });
    return { sfmDoc, containerId: root.id, depotId: depot.id, sinkId: sink.id };
  }

  it("rejects a fluid part connecting into a Depot", () => {
    const { sfmDoc, depotId } = makeDepotDoc();
    expect(
      isValidPortConnection(sfmDoc, {
        source: "producer",
        sourceHandle: "out:Water",
        target: depotId,
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBe(false);
  });

  it("accepts a solid part connecting into an empty Depot", () => {
    const { sfmDoc, depotId } = makeDepotDoc();
    expect(
      isValidPortConnection(sfmDoc, {
        source: "producer",
        sourceHandle: "out:Iron Plate",
        target: depotId,
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBe(true);
  });

  it("rejects a second, different part once the Depot already has one connected", () => {
    const { sfmDoc, containerId, depotId } = makeDepotDoc();
    connectPorts(sfmDoc, containerId, {
      source: "producerA",
      sourceHandle: "out:Iron Plate",
      target: depotId,
      targetHandle: `in:${WILDCARD_PART}`,
    });
    expect(
      isValidPortConnection(sfmDoc, {
        source: "producerB",
        sourceHandle: "out:Iron Rod",
        target: depotId,
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBe(false);
  });

  it("still accepts more of the SAME part once the Depot already has one connected", () => {
    const { sfmDoc, containerId, depotId } = makeDepotDoc();
    connectPorts(sfmDoc, containerId, {
      source: "producerA",
      sourceHandle: "out:Iron Plate",
      target: depotId,
      targetHandle: `in:${WILDCARD_PART}`,
    });
    expect(
      isValidPortConnection(sfmDoc, {
        source: "producerB",
        sourceHandle: "out:Iron Plate",
        target: depotId,
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBe(true);
  });

  it("leaves an AWESOME Sink unaffected — still accepts fluids and multiple distinct parts", () => {
    const { sfmDoc, containerId, sinkId } = makeDepotDoc();
    expect(
      isValidPortConnection(sfmDoc, {
        source: "producer",
        sourceHandle: "out:Water",
        target: sinkId,
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBe(true);
    connectPorts(sfmDoc, containerId, {
      source: "producerA",
      sourceHandle: "out:Iron Plate",
      target: sinkId,
      targetHandle: `in:${WILDCARD_PART}`,
    });
    expect(
      isValidPortConnection(sfmDoc, {
        source: "producerB",
        sourceHandle: "out:Iron Rod",
        target: sinkId,
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBe(true);
  });
});

describe("Storage Container connection restrictions", () => {
  // Mirrors `makeDepotDoc` above — a storage node accepting both directions
  // (unlike a Depot's input-only) plus a plain recipe-shaped node to connect
  // it to.
  function makeStorageDoc() {
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
      recipe: null,
      machine: null,
      x: 400,
      y: 0,
      title: "",
      color: "#7c3aed",
      limit: null,
      limitMode: "machines" as const,
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    };
    const storage = addNode(sfmDoc, { ...baseNode, kind: "storage", title: "Storage Container" });
    return { sfmDoc, containerId: root.id, storageId: storage.id };
  }

  it("accepts a fluid part into an empty Storage Container (unlike a Depot)", () => {
    const { sfmDoc, storageId } = makeStorageDoc();
    expect(
      isValidPortConnection(sfmDoc, {
        source: "producer",
        sourceHandle: "out:Water",
        target: storageId,
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBe(true);
  });

  it("rejects a second, different part once the Storage Container already has one connected, on either side", () => {
    const { sfmDoc, containerId, storageId } = makeStorageDoc();
    connectPorts(sfmDoc, containerId, {
      source: "producerA",
      sourceHandle: "out:Iron Plate",
      target: storageId,
      targetHandle: `in:${WILDCARD_PART}`,
    });
    // A different part rejected on the INPUT side...
    expect(
      isValidPortConnection(sfmDoc, {
        source: "producerB",
        sourceHandle: "out:Iron Rod",
        target: storageId,
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBe(false);
    // ...and on the OUTPUT side.
    expect(
      isValidPortConnection(sfmDoc, {
        source: storageId,
        sourceHandle: `out:${WILDCARD_PART}`,
        target: "consumer",
        targetHandle: "in:Iron Rod",
      }),
    ).toBe(false);
  });

  it("still accepts more of the SAME part, and the matching output side, once one is connected", () => {
    const { sfmDoc, containerId, storageId } = makeStorageDoc();
    connectPorts(sfmDoc, containerId, {
      source: "producerA",
      sourceHandle: "out:Iron Plate",
      target: storageId,
      targetHandle: `in:${WILDCARD_PART}`,
    });
    expect(
      isValidPortConnection(sfmDoc, {
        source: "producerB",
        sourceHandle: "out:Iron Plate",
        target: storageId,
        targetHandle: `in:${WILDCARD_PART}`,
      }),
    ).toBe(true);
    expect(
      isValidPortConnection(sfmDoc, {
        source: storageId,
        sourceHandle: `out:${WILDCARD_PART}`,
        target: "consumer",
        targetHandle: "in:Iron Plate",
      }),
    ).toBe(true);
  });
});

describe("storageNodePart", () => {
  it("is undefined for a storage node with no connections", () => {
    const { sfmDoc, nodeA } = makeDoc();
    expect(storageNodePart(sfmDoc, nodeA)).toBeUndefined();
  });

  it("reads the held part off whichever side (in or out) is wired", () => {
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
    const storage = addNode(sfmDoc, {
      containerId: root.id,
      kind: "storage",
      recipe: null,
      machine: null,
      x: 400,
      y: 0,
      title: "Storage Container",
      color: "#7c3aed",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });
    connectPorts(sfmDoc, root.id, {
      source: storage.id,
      sourceHandle: `out:${WILDCARD_PART}`,
      target: "consumer",
      targetHandle: "in:Iron Plate",
    });
    expect(storageNodePart(sfmDoc, storage.id)).toBe("Iron Plate");
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
