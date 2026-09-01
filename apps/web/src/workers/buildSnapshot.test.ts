import { addContainer, addEdge, addNode, createDocument, type SfmDocument } from "@scm/ydoc";
import { solve } from "@scm/solver";
import { describe, expect, it } from "vitest";

import { encodeSplitterConfig, wildcardSlot } from "../canvas/nodes/splitMergeConfig";
import { buildSolverSnapshot } from "./buildSnapshot";
import { sinkConsumerNodeId } from "./sinkPassthrough";

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
    splitterVariant: null,
    mergerVariant: null,
    ...overrides,
  });
}

describe("buildSolverSnapshot", () => {
  it("includes only kind:recipe nodes", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

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
      splitterVariant: null,
    mergerVariant: null,
    });

    const snapshot = buildSolverSnapshot(sfmDoc);
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]!.id).toBe(recipe.id);
  });

  it("maps NodeRecord fields onto SolverNode with the documented conventions", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

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
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
    makeRecipeNode(sfmDoc, root, { recipe: null, machine: null });

    const snapshot = buildSolverSnapshot(sfmDoc);
    expect(snapshot.nodes[0]!.recipe).toBe("");
    expect(snapshot.nodes[0]!.machine).toBe("");
  });

  it("includes an edge only when both endpoints are recipe nodes", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

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
      splitterVariant: null,
    mergerVariant: null,
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
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
    const outpost = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: root,
      title: "Outpost",
      color: "#000",
      x: 0,
      y: 0,
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

  describe("Splitter/Merger pass-through", () => {
    function makeSplitter(
      sfmDoc: SfmDocument,
      containerId: string,
      overrides: Partial<Parameters<typeof addNode>[1]> = {},
    ) {
      return addNode(sfmDoc, {
        containerId,
        kind: "splitter",
        recipe: null,
        machine: null,
        x: 0,
        y: 0,
        title: "Splitter",
        color: "#000",
        limit: null,
        limitMode: "machines",
        clock: null,
        autoRound: false,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: null,
        splitterVariant: "basic",
        mergerVariant: null,
        priorityOrder: [],
        ...overrides,
      });
    }

    function makeMerger(
      sfmDoc: SfmDocument,
      containerId: string,
      overrides: Partial<Parameters<typeof addNode>[1]> = {},
    ) {
      return addNode(sfmDoc, {
        containerId,
        kind: "merger",
        recipe: null,
        machine: null,
        x: 0,
        y: 0,
        title: "Merger",
        color: "#000",
        limit: null,
        limitMode: "machines",
        clock: null,
        autoRound: false,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: null,
        splitterVariant: null,
        mergerVariant: "basic",
        priorityOrder: [],
        ...overrides,
      });
    }

    it("never turns a Splitter or Merger itself into a SolverNode", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
      const splitter = makeSplitter(sfmDoc, root);
      const merger = makeMerger(sfmDoc, root);
      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.nodes.some((n) => n.id === splitter.id)).toBe(false);
      expect(snapshot.nodes.some((n) => n.id === merger.id)).toBe(false);
    });

    it("rewrites a Smart Splitter's 1-input/2-output wiring into direct recipe-to-recipe edges, Overflow ranked below Any", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

      const producer = makeRecipeNode(sfmDoc, root, { title: "Producer" });
      const consumerA = makeRecipeNode(sfmDoc, root, { title: "ConsumerA" });
      const consumerB = makeRecipeNode(sfmDoc, root, { title: "ConsumerB" });
      // Slot 0 defaults to "any" (rank 0); slot 1 explicitly configured as
      // "overflow" (rank 1).
      const splitter = makeSplitter(sfmDoc, root, {
        splitterVariant: "smart",
        priorityOrder: encodeSplitterConfig(new Map([[1, { rule: "overflow", items: [] }]])),
      });

      const inEdge = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: producer.id,
        fromPort: "out:Iron Ingot",
        toNode: splitter.id,
        toPort: "in:*",
        style: null,
        labelPos: null,
      });
      const outA = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: splitter.id,
        fromPort: `out:${wildcardSlot(0)}`,
        toNode: consumerA.id,
        toPort: "in:Iron Ingot",
        style: null,
        labelPos: null,
      });
      const outB = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: splitter.id,
        fromPort: `out:${wildcardSlot(1)}`,
        toNode: consumerB.id,
        toPort: "in:Iron Ingot",
        style: null,
        labelPos: null,
      });

      const snapshot = buildSolverSnapshot(sfmDoc);
      // Producer, ConsumerA, ConsumerB only — never the Splitter itself.
      expect(snapshot.nodes.map((n) => n.id).sort()).toEqual([consumerA.id, consumerB.id, producer.id].sort());
      expect(snapshot.edges).toHaveLength(2);

      const toA = snapshot.edges.find((e) => e.toNode === consumerA.id)!;
      expect(toA).toMatchObject({ fromNode: producer.id, toNode: consumerA.id, part: "Iron Ingot", priorityTier: 0 });
      const toB = snapshot.edges.find((e) => e.toNode === consumerB.id)!;
      expect(toB).toMatchObject({ fromNode: producer.id, toNode: consumerB.id, part: "Iron Ingot", priorityTier: 1 });

      // Sanity: the original edges into/out of the Splitter never themselves
      // survive into the snapshot (their endpoints aren't both recipe nodes).
      expect(snapshot.edges.some((e) => e.id === inEdge.id || e.id === outA.id || e.id === outB.id)).toBe(false);
    });

    it("rewrites a Priority Merger's 3-input/1-output wiring into direct edges carrying High/Medium/Low as ranks 0/1/2", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

      const producerHigh = makeRecipeNode(sfmDoc, root, { title: "High" });
      const producerLow = makeRecipeNode(sfmDoc, root, { title: "Low" });
      const consumer = makeRecipeNode(sfmDoc, root, { title: "Consumer" });
      const merger = makeMerger(sfmDoc, root, {
        mergerVariant: "priority",
        priorityOrder: [`0:high`, `1:low`],
      });

      const inHigh = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: producerHigh.id,
        fromPort: "out:Iron Ingot",
        toNode: merger.id,
        toPort: `in:${wildcardSlot(0)}`,
        style: null,
        labelPos: null,
      });
      const inLow = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: producerLow.id,
        fromPort: "out:Iron Ingot",
        toNode: merger.id,
        toPort: `in:${wildcardSlot(1)}`,
        style: null,
        labelPos: null,
      });
      const outEdge = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ingot",
        fromNode: merger.id,
        fromPort: "out:*",
        toNode: consumer.id,
        toPort: "in:Iron Ingot",
        style: null,
        labelPos: null,
      });

      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.nodes.map((n) => n.id).sort()).toEqual([consumer.id, producerHigh.id, producerLow.id].sort());
      expect(snapshot.edges).toHaveLength(2);

      const fromHigh = snapshot.edges.find((e) => e.fromNode === producerHigh.id)!;
      expect(fromHigh).toMatchObject({ toNode: consumer.id, part: "Iron Ingot", priorityTier: 0 });
      const fromLow = snapshot.edges.find((e) => e.fromNode === producerLow.id)!;
      expect(fromLow).toMatchObject({ toNode: consumer.id, part: "Iron Ingot", priorityTier: 2 });

      expect(snapshot.edges.some((e) => e.id === inHigh.id || e.id === inLow.id || e.id === outEdge.id)).toBe(false);
    });

    it("excludes a multi-input/multi-output part-group's edges from the snapshot entirely rather than guessing", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

      const producerA = makeRecipeNode(sfmDoc, root, { title: "ProducerA" });
      const producerB = makeRecipeNode(sfmDoc, root, { title: "ProducerB" });
      const consumerA = makeRecipeNode(sfmDoc, root, { title: "ConsumerA" });
      const consumerB = makeRecipeNode(sfmDoc, root, { title: "ConsumerB" });
      // Structurally not a real Splitter shape (its one input handle wired
      // twice AND two of its output slots wired) — the defensive crossbar
      // guard every passthrough node keeps regardless.
      const splitter = makeSplitter(sfmDoc, root);

      for (const producer of [producerA, producerB]) {
        addEdge(sfmDoc, {
          containerId: root,
          part: "Iron Ingot",
          fromNode: producer.id,
          fromPort: "out:Iron Ingot",
          toNode: splitter.id,
          toPort: "in:*",
          style: null,
          labelPos: null,
        });
      }
      const slots = [wildcardSlot(0), wildcardSlot(1)] as const;
      for (const [i, consumer] of [consumerA, consumerB].entries()) {
        addEdge(sfmDoc, {
          containerId: root,
          part: "Iron Ingot",
          fromNode: splitter.id,
          fromPort: `out:${slots[i]}`,
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
        splitterVariant: null,
    mergerVariant: null,
        ...overrides,
      });
    }

    it("never turns a Sink itself into a SolverNode", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
      const sink = makeSink(sfmDoc, root);
      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.nodes.some((n) => n.id === sink.id)).toBe(false);
    });

    it("caps the upstream producer's rate at the sink's own ppm limit", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

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
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

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
        splitterVariant: null,
    mergerVariant: null,
        ...overrides,
      });
    }

    it("never turns a Storage Container itself into a SolverNode", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
      const storage = makeStorage(sfmDoc, root);
      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.nodes.some((n) => n.id === storage.id)).toBe(false);
    });

    it("decouples input from output — a pinned upstream producer and a differently-pinned downstream consumer both resolve independently, with no forced conservation across the storage node", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

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
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });

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

  describe("Outpost I/O rework: outpost-input/outpost-output pass-through", () => {
    function makeIoNode(sfmDoc: SfmDocument, containerId: string, kind: "outpost-input" | "outpost-output", id: string) {
      return addNode(sfmDoc, {
        id,
        containerId,
        kind,
        recipe: null,
        machine: null,
        x: 0,
        y: 0,
        title: kind === "outpost-input" ? "Inputs" : "Outputs",
        color: "#d97706",
        limit: null,
        limitMode: "machines",
        clock: null,
        autoRound: false,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: null,
        splitterVariant: null,
    mergerVariant: null,
      });
    }

    it("never turns an outpost-input/outpost-output node itself into a SolverNode", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
      const outpost = addContainer(sfmDoc, { kind: "outpost", parentId: root, title: "Outpost", color: "#000", x: 0, y: 0 });
      const inputs = makeIoNode(sfmDoc, outpost.id, "outpost-input", "io-in:" + outpost.id);

      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.nodes.some((n) => n.id === inputs.id)).toBe(false);
    });

    it("rewrites a chain crossing through the Inputs and Outputs nodes into one direct recipe-to-recipe edge, exactly as if the outpost weren't there", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
      const outpost = addContainer(sfmDoc, { kind: "outpost", parentId: root, title: "Outpost", color: "#000", x: 0, y: 0 });

      const externalProducer = makeRecipeNode(sfmDoc, root, { title: "External producer" });
      const internalConsumer = makeRecipeNode(sfmDoc, outpost.id, { title: "Internal consumer", recipe: "Iron Plate", machine: "Constructor" });
      const inputs = makeIoNode(sfmDoc, outpost.id, "outpost-input", "io-in:" + outpost.id);

      const externalToInputs = addEdge(sfmDoc, {
        containerId: root,
        part: "Iron Ore",
        fromNode: externalProducer.id,
        fromPort: "out:Iron Ore",
        toNode: inputs.id,
        toPort: "in:*",
        style: null,
        labelPos: null,
      });
      const inputsToInternal = addEdge(sfmDoc, {
        containerId: outpost.id,
        part: "Iron Ore",
        fromNode: inputs.id,
        fromPort: "out:*",
        toNode: internalConsumer.id,
        toPort: "in:Iron Ore",
        style: null,
        labelPos: null,
      });

      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.nodes.map((n) => n.id).sort()).toEqual([externalProducer.id, internalConsumer.id].sort());
      expect(snapshot.edges).toHaveLength(1);
      expect(snapshot.edges[0]).toMatchObject({ fromNode: externalProducer.id, toNode: internalConsumer.id, part: "Iron Ore" });
      // The original two edges into/out of the Inputs node never themselves survive — both endpoints must be recipe nodes.
      expect(snapshot.edges.some((e) => e.id === externalToInputs.id || e.id === inputsToInternal.id)).toBe(false);
    });

    it("composes a chain through the Outputs node INTO an AWESOME Sink — the sink actually receives the producer's full rate, not just the ORIGINAL edge (fromNode isn't a recipe) or the outpost rewrite's synthetic edge (toNode isn't a recipe) individually", () => {
      // Regression test for the exact bug reported live: "only 1ppm flows
      // unless a limit is set" — the sink's own unresolved-fallback kicking
      // in because neither independent rewrite alone produced an edge with
      // BOTH endpoints representable.
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
      const outpost = addContainer(sfmDoc, { kind: "outpost", parentId: root, title: "Outpost", color: "#000", x: 0, y: 0 });

      const producer = makeRecipeNode(sfmDoc, outpost.id, { title: "Producer", limit: "2", limitMode: "machines" });
      const outputs = makeIoNode(sfmDoc, outpost.id, "outpost-output", "io-out:" + outpost.id);
      const sink = addNode(sfmDoc, {
        containerId: root,
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
        splitterVariant: null,
    mergerVariant: null,
      });

      addEdge(sfmDoc, { containerId: outpost.id, part: "Iron Ingot", fromNode: producer.id, fromPort: "out:Iron Ingot", toNode: outputs.id, toPort: "in:*", style: null, labelPos: null });
      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: outputs.id, fromPort: "out:*", toNode: sink.id, toPort: "in:*", style: null, labelPos: null });

      // The decisive check: a real `SolverEdge` from the PRODUCER straight to
      // the sink's own synthetic consumer node must exist. Under the old,
      // unordered rewrite this was ALWAYS zero (neither independent rewrite
      // alone had two representable endpoints) — a pinned producer's own
      // `resolved` flag doesn't depend on this at all, so that alone
      // wouldn't have caught the regression; this edge's existence is what
      // actually distinguishes fixed from broken.
      const snapshot = buildSolverSnapshot(sfmDoc);
      const consumerNodeId = sinkConsumerNodeId(sink.id, "Iron Ingot");
      expect(snapshot.nodes.some((n) => n.id === consumerNodeId)).toBe(true);
      expect(snapshot.edges).toEqual([
        expect.objectContaining({ fromNode: producer.id, toNode: consumerNodeId, part: "Iron Ingot" }),
      ]);

      // And the sink's synthetic consumer must actually resolve to the
      // producer's FULL rate — not the "no real edge, nothing to infer
      // from" default that produced the reported "only 1ppm" symptom.
      const result = solve(snapshot, "basic");
      const consumerResult = result.nodes.find((n) => n.nodeId === consumerNodeId)!;
      const producerResult = result.nodes.find((n) => n.nodeId === producer.id)!;
      expect(consumerResult.resolved).toBe(true);
      expect(consumerResult.partRates["Iron Ingot"]).toBe(`-${producerResult.partRates["Iron Ingot"]}`);
    });

    it("splitting an outpost output between a real recipe AND a Sink solves BOTH branches (not just one)", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
      const outpost = addContainer(sfmDoc, { kind: "outpost", parentId: root, title: "Outpost", color: "#000", x: 0, y: 0 });

      const producer = makeRecipeNode(sfmDoc, outpost.id, { title: "Producer", limit: "1", limitMode: "machines" });
      const outputs = makeIoNode(sfmDoc, outpost.id, "outpost-output", "io-out:" + outpost.id);
      const craftingConsumer = makeRecipeNode(sfmDoc, root, { title: "Crafting consumer", recipe: "Iron Plate", machine: "Constructor" });
      const sink = addNode(sfmDoc, {
        containerId: root,
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
        splitterVariant: null,
    mergerVariant: null,
      });

      addEdge(sfmDoc, { containerId: outpost.id, part: "Iron Ingot", fromNode: producer.id, fromPort: "out:Iron Ingot", toNode: outputs.id, toPort: "in:*", style: null, labelPos: null });
      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: outputs.id, fromPort: "out:*", toNode: craftingConsumer.id, toPort: "in:Iron Ingot", style: null, labelPos: null });
      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: outputs.id, fromPort: "out:*", toNode: sink.id, toPort: "in:*", style: null, labelPos: null });

      const snapshot = buildSolverSnapshot(sfmDoc);
      // Two real solver edges must exist — one per branch — not just one.
      expect(snapshot.edges.filter((e) => e.part === "Iron Ingot")).toHaveLength(2);
      expect(snapshot.edges.some((e) => e.toNode === craftingConsumer.id)).toBe(true);
      const sinkConsumerEdge = snapshot.edges.find((e) => e.toNode !== craftingConsumer.id && e.part === "Iron Ingot");
      expect(sinkConsumerEdge).toBeDefined();
      expect(sinkConsumerEdge!.fromNode).toBe(producer.id);

      const result = solve(snapshot, "basic");
      const producerResult = result.nodes.find((n) => n.nodeId === producer.id)!;
      expect(producerResult.resolved).toBe(true);
      expect(producerResult.valid).toBe(true);
    });

    it("composes the same chain into a Storage Container", () => {
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
      const outpost = addContainer(sfmDoc, { kind: "outpost", parentId: root, title: "Outpost", color: "#000", x: 0, y: 0 });

      const producer = makeRecipeNode(sfmDoc, outpost.id, { title: "Producer", limit: "2", limitMode: "machines" });
      const outputs = makeIoNode(sfmDoc, outpost.id, "outpost-output", "io-out:" + outpost.id);
      const storage = addNode(sfmDoc, {
        containerId: root,
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
        splitterVariant: null,
    mergerVariant: null,
      });

      addEdge(sfmDoc, { containerId: outpost.id, part: "Iron Ingot", fromNode: producer.id, fromPort: "out:Iron Ingot", toNode: outputs.id, toPort: "in:*", style: null, labelPos: null });
      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: outputs.id, fromPort: "out:*", toNode: storage.id, toPort: "in:*", style: null, labelPos: null });

      const snapshot = buildSolverSnapshot(sfmDoc);
      expect(snapshot.edges.some((e) => e.part === "Iron Ingot" && e.fromNode === producer.id)).toBe(true);
    });

    it("composes a chain crossing an outpost's OWN Inputs->Outputs pass-through AND on into a Dimensional Depot two hops away — the depot receives the producer's full rate, not the flat 1-machine default", () => {
      // Regression test: "just passing items through an outpost without
      // doing anything with it" reported live as the Depot showing 1ppm
      // instead of the real upstream rate. The single-hop ordering fix
      // above (the previous test in this describe block) composes ONE
      // pass-through hop; this chain has TWO (the outpost's own Inputs node,
      // then its own Outputs node) before ever reaching the Depot, which
      // needed `computeSplurgerPassthroughEdges` to fold sequentially
      // instead of each node rewriting independently against the same raw
      // edges (see that function's own header).
      const sfmDoc = createDocument();
      const root = "root";
      addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0 });
      const outpost = addContainer(sfmDoc, { kind: "outpost", parentId: root, title: "New Outpost", color: "#000", x: 0, y: 0 });

      const producer = makeRecipeNode(sfmDoc, root, { title: "Producer", limit: "2", limitMode: "machines" });
      const inputs = makeIoNode(sfmDoc, outpost.id, "outpost-input", "io-in:" + outpost.id);
      const outputs = makeIoNode(sfmDoc, outpost.id, "outpost-output", "io-out:" + outpost.id);
      const depot = addNode(sfmDoc, {
        containerId: root,
        kind: "depot",
        recipe: null,
        machine: "Dimensional Depot Uploader",
        x: 0,
        y: 0,
        title: "Dimensional Depot",
        color: "#000",
        limit: null,
        limitMode: "ppm",
        clock: null,
        autoRound: false,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: null,
        splitterVariant: null,
    mergerVariant: null,
      });

      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: producer.id, fromPort: "out:Iron Ingot", toNode: inputs.id, toPort: "in:*", style: null, labelPos: null });
      addEdge(sfmDoc, { containerId: outpost.id, part: "Iron Ingot", fromNode: inputs.id, fromPort: "out:*", toNode: outputs.id, toPort: "in:*", style: null, labelPos: null });
      addEdge(sfmDoc, { containerId: root, part: "Iron Ingot", fromNode: outputs.id, fromPort: "out:*", toNode: depot.id, toPort: "in:*", style: null, labelPos: null });

      const snapshot = buildSolverSnapshot(sfmDoc);
      const consumerNodeId = sinkConsumerNodeId(depot.id, "Iron Ingot");
      expect(snapshot.nodes.some((n) => n.id === consumerNodeId)).toBe(true);
      expect(snapshot.edges).toEqual([
        expect.objectContaining({ fromNode: producer.id, toNode: consumerNodeId, part: "Iron Ingot" }),
      ]);

      const result = solve(snapshot, "basic");
      const consumerResult = result.nodes.find((n) => n.nodeId === consumerNodeId)!;
      const producerResult = result.nodes.find((n) => n.nodeId === producer.id)!;
      expect(consumerResult.resolved).toBe(true);
      expect(consumerResult.partRates["Iron Ingot"]).toBe(`-${producerResult.partRates["Iron Ingot"]}`);
    });
  });
});
