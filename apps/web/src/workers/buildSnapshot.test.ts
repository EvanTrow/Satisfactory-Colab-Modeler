import { addContainer, addEdge, addNode, createDocument, type SfmDocument } from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { buildSolverSnapshot } from "./buildSnapshot";

function makeRecipeNode(
  sfmDoc: SfmDocument,
  containerId: string,
  overrides: Partial<Parameters<typeof addNode>[1]> = {},
) {
  return addNode(sfmDoc, {
    containerId,
    kind: "recipe",
    recipe: "Iron Ingot",
    machine: "Smelter",
    x: 0,
    y: 0,
    title: "Iron Ingot",
    color: "#fff",
    limit: null,
    limitMode: "machines",
    clock: null,
    autoRound: false,
    shards: 0,
    purity: null,
    beltTier: null,
    storageMode: null,
    ...overrides,
  });
}

describe("buildSolverSnapshot", () => {
  it("includes only kind:recipe nodes", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });

    const recipe = makeRecipeNode(sfmDoc, root, { title: "Recipe node" });
    addNode(sfmDoc, {
      containerId: root,
      kind: "debug",
      recipe: null,
      machine: null,
      x: 10,
      y: 10,
      title: "Debug node",
      color: "#000",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
    });

    const snapshot = buildSolverSnapshot(sfmDoc);
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]!.id).toBe(recipe.id);
  });

  it("maps NodeRecord fields onto SolverNode with the documented conventions", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });

    makeRecipeNode(sfmDoc, root, {
      recipe: "Iron Ore",
      machine: "Miner Mk.3",
      purity: "pure",
      limit: "2",
      limitMode: "machines",
      clock: "150",
      shards: 2,
    });

    const snapshot = buildSolverSnapshot(sfmDoc);
    expect(snapshot.nodes[0]).toMatchObject({
      recipe: "Iron Ore",
      machine: "Miner Mk.3",
      purity: "pure",
      limit: "2",
      limitMode: "machines",
      clock: "150",
      shards: 2,
    });
  });

  it("maps null recipe/machine to empty strings rather than passing null through", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });
    makeRecipeNode(sfmDoc, root, { recipe: null, machine: null });

    const snapshot = buildSolverSnapshot(sfmDoc);
    expect(snapshot.nodes[0]!.recipe).toBe("");
    expect(snapshot.nodes[0]!.machine).toBe("");
  });

  it("includes an edge only when both endpoints are recipe nodes", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });

    const a = makeRecipeNode(sfmDoc, root, { title: "A" });
    const b = makeRecipeNode(sfmDoc, root, { title: "B" });
    const debugNode = addNode(sfmDoc, {
      containerId: root,
      kind: "debug",
      recipe: null,
      machine: null,
      x: 0,
      y: 0,
      title: "Debug",
      color: "#000",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
    });

    addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: a.id, fromPort: "out", toNode: b.id, toPort: "in", style: null, labelPos: null });
    addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: a.id, fromPort: "out2", toNode: debugNode.id, toPort: "in", style: null, labelPos: null });

    const snapshot = buildSolverSnapshot(sfmDoc);
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]!.fromNode).toBe(a.id);
    expect(snapshot.edges[0]!.toNode).toBe(b.id);
  });

  it("builds the real underlying graph across container boundaries, not a container-scoped slice — the same result regardless of which outpost each node currently lives in", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });
    const outpost = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root,
      title: "Outpost",
      color: "#000",
      x: 0,
      y: 0,
      copiesLimit: null,
    });

    // `a` lives in the outpost, `b` lives at root — a real boundary-crossing
    // connection per Job 013's design (the edge itself just names two real
    // node ids; it doesn't know or care that they're in different
    // containers). This must show up as ONE connected component, exactly as
    // if both nodes were in the same container.
    const a = makeRecipeNode(sfmDoc, outpost.id, { title: "Inside outpost" });
    const b = makeRecipeNode(sfmDoc, root, { title: "At root" });
    addEdge(sfmDoc, { containerId: outpost.id, part: "Iron Ingot", fromNode: a.id, fromPort: "out", toNode: b.id, toPort: "in", style: null, labelPos: null });

    const snapshot = buildSolverSnapshot(sfmDoc);
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(snapshot.edges).toHaveLength(1);
  });
});
