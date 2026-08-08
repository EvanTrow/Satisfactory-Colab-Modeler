import { addContainer, addEdge, addNode, createDocument, setPriorityOrder, type SfmDocument } from "@scm/ydoc";
import { solve } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { buildSolverSnapshot } from "./buildSnapshot";
import { encodePriorityOrder } from "./splurgerPassthrough";

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
    splurgerVariant: null,
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
      splurgerVariant: null,
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
      splurgerVariant: null,
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

  describe("Job 024: Splurger pass-through", () => {
    function makeSplurger(sfmDoc: SfmDocument, containerId: string) {
      return addNode(sfmDoc, {
        containerId,
        kind: "splurger",
        recipe: null,
        machine: null,
        x: 0,
        y: 0,
        title: "Splurger",
        color: "#000",
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
    }

    it("never turns a Splurger itself into a SolverNode", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });
      const splurger = makeSplurger(sfmDoc, root);
      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.nodes.some((n) => n.id === splurger.id)).toBe(false);
    });

    it("rewrites a 1-input/N-output Splurger into direct recipe-to-recipe edges carrying the assigned tier", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });

      const producer = makeRecipeNode(sfmDoc, root, { title: "Producer" });
      const consumerA = makeRecipeNode(sfmDoc, root, { title: "ConsumerA" });
      const consumerB = makeRecipeNode(sfmDoc, root, { title: "ConsumerB" });
      const splurger = makeSplurger(sfmDoc, root);

      const inEdge = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: producer.id,
        fromPort: "out:Iron Ingot",
        toNode: splurger.id,
        toPort: "in:*",
        style: null,
        labelPos: null,
      });
      const outA = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: splurger.id,
        fromPort: "out:*",
        toNode: consumerA.id,
        toPort: "in:Iron Ingot",
        style: null,
        labelPos: null,
      });
      const outB = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: splurger.id,
        fromPort: "out:*",
        toNode: consumerB.id,
        toPort: "in:Iron Ingot",
        style: null,
        labelPos: null,
      });
      setPriorityOrder(sfmDoc, splurger.id, encodePriorityOrder({ top: [outA.id], bottom: [outB.id] }));

      const snapshot = buildSolverSnapshot(sfmDoc);
      // Producer, ConsumerA, ConsumerB only — never the Splurger itself.
      expect(snapshot.nodes.map((n) => n.id).sort()).toEqual([consumerA.id, consumerB.id, producer.id].sort());
      expect(snapshot.edges).toHaveLength(2);

      const toA = snapshot.edges.find((e) => e.toNode === consumerA.id)!;
      expect(toA).toMatchObject({ fromNode: producer.id, toNode: consumerA.id, part: "Iron Ingot", priorityTier: "top" });
      const toB = snapshot.edges.find((e) => e.toNode === consumerB.id)!;
      expect(toB).toMatchObject({ fromNode: producer.id, toNode: consumerB.id, part: "Iron Ingot", priorityTier: "bottom" });

      // Sanity: the original edges into/out of the Splurger never themselves
      // survive into the snapshot (their endpoints aren't both recipe nodes).
      expect(snapshot.edges.some((e) => e.id === inEdge.id || e.id === outA.id || e.id === outB.id)).toBe(false);
    });

    it("excludes a multi-input/multi-output Splurger's edges from the snapshot entirely rather than guessing", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });

      const producerA = makeRecipeNode(sfmDoc, root, { title: "ProducerA" });
      const producerB = makeRecipeNode(sfmDoc, root, { title: "ProducerB" });
      const consumerA = makeRecipeNode(sfmDoc, root, { title: "ConsumerA" });
      const consumerB = makeRecipeNode(sfmDoc, root, { title: "ConsumerB" });
      const splurger = makeSplurger(sfmDoc, root);

      for (const producer of [producerA, producerB]) {
        addEdge(sfmDoc, {
          containerId: root,
          part: "Iron Ingot",
          fromNode: producer.id,
          fromPort: "out:Iron Ingot",
          toNode: splurger.id,
          toPort: "in:*",
          style: null,
          labelPos: null,
        });
      }
      for (const consumer of [consumerA, consumerB]) {
        addEdge(sfmDoc, {
          containerId: root,
          part: "Iron Ingot",
          fromNode: splurger.id,
          fromPort: "out:*",
          toNode: consumer.id,
          toPort: "in:Iron Ingot",
          style: null,
          labelPos: null,
        });
      }

      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.edges).toHaveLength(0);
    });
  });

  describe("AWESOME Sink / Dimensional Depot rewrite", () => {
    function makeSink(sfmDoc: SfmDocument, containerId: string, overrides: Partial<Parameters<typeof addNode>[1]> = {}) {
      return addNode(sfmDoc, {
        containerId,
        kind: "sink",
        recipe: null,
        machine: "AWESOME Sink",
        x: 0,
        y: 0,
        title: "AWESOME Sink",
        color: "#000",
        limit: null,
        limitMode: "ppm",
        clock: null,
        autoRound: false,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: null,
        splurgerVariant: null,
        ...overrides,
      });
    }

    it("never turns a Sink itself into a SolverNode", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });
      const sink = makeSink(sfmDoc, root);
      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.nodes.some((n) => n.id === sink.id)).toBe(false);
    });

    it("caps the upstream producer's rate at the sink's own ppm limit", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });

      const producer = makeRecipeNode(sfmDoc, root, { title: "Producer" });
      const sink = makeSink(sfmDoc, root, { limit: "10", limitMode: "ppm" });
      addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: producer.id,
        fromPort: "out:Iron Ingot",
        toNode: sink.id,
        toPort: "in:*",
        style: null,
        labelPos: null,
      });

      const snapshot = buildSolverSnapshot(sfmDoc);
      const result = solve(snapshot, "basic");
      const producerResult = result.nodes.find((n) => n.nodeId === producer.id)!;
      expect(producerResult.resolved).toBe(true);
      expect(producerResult.partRates["Iron Ingot"]).toBe("10");
    });

    it("consumes each distinct connected part independently, at the sink's own limit each", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });

      const ironProducer = makeRecipeNode(sfmDoc, root, { title: "Iron", recipe: "Iron Ingot", machine: "Smelter" });
      const copperProducer = makeRecipeNode(sfmDoc, root, { title: "Copper", recipe: "Copper Ingot", machine: "Smelter" });
      const sink = makeSink(sfmDoc, root, { limit: "20", limitMode: "ppm" });
      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: ironProducer.id, fromPort: "out:Iron Ingot", toNode: sink.id, toPort: "in:*", style: null, labelPos: null });
      addEdge(sfmDoc, { containerId: root, part: "Copper Ingot", fromNode: copperProducer.id, fromPort: "out:Copper Ingot", toNode: sink.id, toPort: "in:*", style: null, labelPos: null });

      const snapshot = buildSolverSnapshot(sfmDoc);
      const result = solve(snapshot, "basic");
      expect(result.nodes.find((n) => n.nodeId === ironProducer.id)!.partRates["Iron Ingot"]).toBe("20");
      expect(result.nodes.find((n) => n.nodeId === copperProducer.id)!.partRates["Copper Ingot"]).toBe("20");
    });
  });

  describe("Storage Container rewrite", () => {
    function makeStorage(sfmDoc: SfmDocument, containerId: string, overrides: Partial<Parameters<typeof addNode>[1]> = {}) {
      return addNode(sfmDoc, {
        containerId,
        kind: "storage",
        recipe: null,
        machine: null,
        x: 0,
        y: 0,
        title: "Storage Container",
        color: "#000",
        limit: null,
        limitMode: "machines",
        clock: null,
        autoRound: false,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: "partiallyFull",
        splurgerVariant: null,
        ...overrides,
      });
    }

    it("never turns a Storage Container itself into a SolverNode", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });
      const storage = makeStorage(sfmDoc, root);
      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.nodes.some((n) => n.id === storage.id)).toBe(false);
    });

    it("decouples input from output — a pinned upstream producer and a differently-pinned downstream consumer both resolve independently, with no forced conservation across the storage node", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });

      const producer = makeRecipeNode(sfmDoc, root, { title: "Producer", limit: "5", limitMode: "machines" });
      const consumer = makeRecipeNode(sfmDoc, root, { title: "Consumer", recipe: "Iron Rod", machine: "Constructor", limit: "3", limitMode: "machines" });
      const storage = makeStorage(sfmDoc, root);

      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: producer.id, fromPort: "out:Iron Ingot", toNode: storage.id, toPort: "in:*", style: null, labelPos: null });
      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: storage.id, fromPort: "out:*", toNode: consumer.id, toPort: "in:Iron Ingot", style: null, labelPos: null });

      const snapshot = buildSolverSnapshot(sfmDoc);
      const result = solve(snapshot, "basic");
      expect(result.valid).toBe(true);
      const producerResult = result.nodes.find((n) => n.nodeId === producer.id)!;
      const consumerResult = result.nodes.find((n) => n.nodeId === consumer.id)!;
      expect(producerResult.machineCount).toBe("5");
      expect(consumerResult.machineCount).toBe("3");
    });

    it("routes multiple producers of the same part into one shared consumer node on the input side", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });

      // Basic mode has no splitter/merger *preference* — a shared consumer's
      // total demand is even-split across its sibling producer edges
      // (PLAN.md §2's "no" for Basic in that column), so two producers with
      // UNEQUAL pinned outputs feeding one synthetic consumer would report a
      // legitimate rate mismatch, exactly as two unequal producers feeding
      // any ordinary recipe node's shared input already would — nothing
      // specific to this rewrite. Equal limits here isolates what this test
      // actually checks: that both producers route to the SAME shared
      // synthetic consumer node rather than two independent ones.
      const producerA = makeRecipeNode(sfmDoc, root, { title: "A", limit: "3", limitMode: "machines" });
      const producerB = makeRecipeNode(sfmDoc, root, { title: "B", limit: "3", limitMode: "machines" });
      const storage = makeStorage(sfmDoc, root);
      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: producerA.id, fromPort: "out:Iron Ingot", toNode: storage.id, toPort: "in:*", style: null, labelPos: null });
      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: producerB.id, fromPort: "out:Iron Ingot", toNode: storage.id, toPort: "in:*", style: null, labelPos: null });

      const snapshot = buildSolverSnapshot(sfmDoc);
      const result = solve(snapshot, "basic");
      expect(result.valid).toBe(true);
      expect(result.nodes.find((n) => n.nodeId === producerA.id)!.machineCount).toBe("3");
      expect(result.nodes.find((n) => n.nodeId === producerB.id)!.machineCount).toBe("3");
    });
  });
});
