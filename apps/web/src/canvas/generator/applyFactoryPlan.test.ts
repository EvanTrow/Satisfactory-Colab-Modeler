// Real-`SfmDocument` integration test — `planFactory.test.ts` already covers
// the graph math exhaustively against real game data; this just checks the
// Yjs-writing half wires plans into nodes/edges correctly. Same
// `createDocument()` + root-container fixture pattern as
// `selection/clipboard.test.ts`.
import { defaultGameData } from "@scm/gamedata";
import { of, toFractionString } from "@scm/rational";
import { addContainer, createDocument, listEdges, listNodes } from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { applyFactoryPlan } from "./applyFactoryPlan";
import { planFactory } from "./planFactory";

const gameData = defaultGameData;

function setUp() {
  const sfmDoc = createDocument();
  const root = addContainer(sfmDoc, {
    kind: "root",
    parentId: null,
    title: "Root",
    color: "#000000",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  return { sfmDoc, root };
}

describe("applyFactoryPlan", () => {
  it("writes one node per planned part and one edge per planned connection, pinned to the exact machine count", () => {
    const { sfmDoc, root } = setUp();
    const plan = planFactory(gameData, "Iron Ingot", of(60));

    const { nodeIdByPart } = applyFactoryPlan(sfmDoc, root.id, plan);

    const nodes = listNodes(sfmDoc);
    expect(nodes).toHaveLength(2);
    expect(nodeIdByPart.size).toBe(2);

    const ironIngotNode = nodes.find((n) => n.id === nodeIdByPart.get("Iron Ingot"))!;
    expect(ironIngotNode.recipe).toBe("Iron Ingot");
    expect(ironIngotNode.limitMode).toBe("machines");
    expect(ironIngotNode.limit).toBe(toFractionString(of(2)));
    expect(ironIngotNode.containerId).toBe(root.id);

    const ironOreNode = nodes.find((n) => n.id === nodeIdByPart.get("Iron Ore"))!;
    expect(ironOreNode.recipe).toBe("Iron Ore");
    expect(ironOreNode.limit).toBe(toFractionString(of(1)));

    const edges = listEdges(sfmDoc);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      part: "Iron Ore",
      fromNode: ironOreNode.id,
      fromPort: "out:Iron Ore",
      toNode: ironIngotNode.id,
      toPort: "in:Iron Ore",
      containerId: root.id,
    });
  });

  it("lays out nodes at distinct, non-overlapping positions instead of stacking them all at the origin", () => {
    const { sfmDoc, root } = setUp();
    const plan = planFactory(gameData, "Rotor", of(4));

    applyFactoryPlan(sfmDoc, root.id, plan, { basePosition: { x: 500, y: 100 } });

    const nodes = listNodes(sfmDoc);
    expect(nodes).toHaveLength(5);
    const positions = nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(nodes.length); // every node lands at a unique position
    expect(nodes.every((n) => n.x >= 500 && n.y >= 100)).toBe(true); // everything clears the requested base position
  });

  it("creates nothing when the target part has no producing recipe", () => {
    const { sfmDoc, root } = setUp();
    const plan = planFactory(gameData, "Not A Real Part", of(60));

    const { nodeIdByPart } = applyFactoryPlan(sfmDoc, root.id, plan);

    expect(nodeIdByPart.size).toBe(0);
    expect(listNodes(sfmDoc)).toHaveLength(0);
    expect(listEdges(sfmDoc)).toHaveLength(0);
  });
});
