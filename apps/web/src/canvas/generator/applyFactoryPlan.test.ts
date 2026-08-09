// Real-`SfmDocument` integration test — `planFactory.test.ts` already covers
// the graph math exhaustively against real game data; this just checks the
// Yjs-writing half wires plans into nodes/edges correctly. Same
// `createDocument()` + root-container fixture pattern as
// `selection/clipboard.test.ts`.
import { defaultGameData, loadGameData } from "@scm/gamedata";
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
    const plan = planFactory(gameData, [{ part: "Iron Ingot", rate: of(60) }]);

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
    const plan = planFactory(gameData, [{ part: "Rotor", rate: of(4) }]);

    applyFactoryPlan(sfmDoc, root.id, plan, { basePosition: { x: 500, y: 100 } });

    const nodes = listNodes(sfmDoc);
    expect(nodes).toHaveLength(5);
    const positions = nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(nodes.length); // every node lands at a unique position
    expect(nodes.every((n) => n.x >= 500 && n.y >= 100)).toBe(true); // everything clears the requested base position
  });

  it("creates nothing when the target part has no producing recipe", () => {
    const { sfmDoc, root } = setUp();
    const plan = planFactory(gameData, [{ part: "Not A Real Part", rate: of(60) }]);

    const { nodeIdByPart } = applyFactoryPlan(sfmDoc, root.id, plan);

    expect(nodeIdByPart.size).toBe(0);
    expect(listNodes(sfmDoc)).toHaveLength(0);
    expect(listEdges(sfmDoc)).toHaveLength(0);
  });

  it("routes a byproduct through a conversion machine into its own AWESOME Sink", () => {
    const { sfmDoc, root } = setUp();
    // Plastic's own recipe produces Heavy Oil Residue as a byproduct, which
    // has a single-input conversion recipe into Petroleum Coke (verified by
    // hand against the real game data — see `planFactory.test.ts`'s own
    // synthetic-fixture coverage for the exact math this exercises).
    const plan = planFactory(gameData, [{ part: "Plastic", rate: of(20) }], { handleByproducts: true });
    expect(plan.byproductDisposals).toHaveLength(1);
    expect(plan.byproductDisposals[0]!.conversion?.recipe.name).toBe("Petroleum Coke");

    applyFactoryPlan(sfmDoc, root.id, plan);

    const nodes = listNodes(sfmDoc);
    const sinkNode = nodes.find((n) => n.kind === "sink");
    expect(sinkNode).toBeDefined();
    expect(sinkNode!.machine).toBe("AWESOME Sink");
    expect(sinkNode!.limitMode).toBe("ppm");
    expect(sinkNode!.limit).toBeNull();

    const conversionNode = nodes.find((n) => n.recipe === "Petroleum Coke");
    expect(conversionNode).toBeDefined();
    expect(conversionNode!.limitMode).toBe("machines");

    const plasticNode = nodes.find((n) => n.recipe === "Plastic")!;
    const edges = listEdges(sfmDoc);

    // Plastic's Heavy Oil Residue byproduct feeds the conversion machine...
    expect(edges).toContainEqual(
      expect.objectContaining({
        part: "Heavy Oil Residue",
        fromNode: plasticNode.id,
        fromPort: "out:Heavy Oil Residue",
        toNode: conversionNode!.id,
        toPort: "in:Heavy Oil Residue",
      }),
    );
    // ...and the conversion machine's own output feeds the sink's wildcard port.
    expect(edges).toContainEqual(
      expect.objectContaining({
        part: "Petroleum Coke",
        fromNode: conversionNode!.id,
        fromPort: "out:Petroleum Coke",
        toNode: sinkNode!.id,
        toPort: "in:*",
      }),
    );
  });

  it("routes a SOLID byproduct straight to the sink when no conversion recipe is available", () => {
    const { sfmDoc, root } = setUp();
    const fixture = loadGameData({
      Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
      MultiMachines: [],
      Parts: [
        { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
        { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
        { Name: "Byproduct", Tier: "0-0", SinkPoints: 0 },
      ],
      Recipes: [
        { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
        {
          Name: "MainOutput",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "RawA", Amount: "-10" },
            { Part: "MainOutput", Amount: "5" },
            { Part: "Byproduct", Amount: "3" },
          ],
        },
      ],
    });
    const plan = planFactory(fixture, [{ part: "MainOutput", rate: of(5) }], { handleByproducts: true });
    expect(plan.byproductDisposals[0]!.conversion).toBeUndefined();
    expect(plan.byproductDisposals[0]!.rawSinkAllowed).toBe(true);

    applyFactoryPlan(sfmDoc, root.id, plan);

    const nodes = listNodes(sfmDoc);
    const sinkNode = nodes.find((n) => n.kind === "sink")!;
    expect(sinkNode).toBeDefined();
    const mainOutputNode = nodes.find((n) => n.recipe === "MainOutput")!;
    expect(listEdges(sfmDoc)).toContainEqual(
      expect.objectContaining({
        part: "Byproduct",
        fromNode: mainOutputNode.id,
        toNode: sinkNode.id,
        toPort: "in:*",
      }),
    );
  });

  it("leaves a fluid/gas byproduct entirely un-wired (no sink, no edge) when nothing can dispose of it", () => {
    const { sfmDoc, root } = setUp();
    // "Petroleum Coke", "Residual Fuel", "Smokeless Powder", "Coated Cable",
    // "Packaged Heavy Oil Residue", and "Diluted Packaged Fuel" are every
    // real-data recipe (as of writing) that consumes Heavy Oil Residue via
    // one or two inputs and produces a solid — disabling all of them leaves
    // genuinely nothing (the remaining consumers need 3+ inputs, or output
    // another fluid, both out of scope). Heavy Oil Residue is a fluid, so
    // this must NOT fall back to sinking it raw.
    const plan = planFactory(gameData, [{ part: "Plastic", rate: of(20) }], {
      handleByproducts: true,
      disabledRecipes: new Set([
        "Petroleum Coke",
        "Residual Fuel",
        "Smokeless Powder",
        "Coated Cable",
        "Packaged Heavy Oil Residue",
        "Diluted Packaged Fuel",
      ]),
    });
    const disposal = plan.byproductDisposals.find((d) => d.part === "Heavy Oil Residue")!;
    expect(disposal.conversion).toBeUndefined();
    expect(disposal.rawSinkAllowed).toBe(false);

    applyFactoryPlan(sfmDoc, root.id, plan);

    expect(listNodes(sfmDoc).some((n) => n.kind === "sink")).toBe(false);
    expect(listEdges(sfmDoc).some((e) => e.part === "Heavy Oil Residue")).toBe(false);
  });

  it("wires a fluid byproduct's packaging support chain (its own machines feeding the conversion machine's second input)", () => {
    const { sfmDoc, root } = setUp();
    const fixture = loadGameData({
      Machines: [
        { Name: "Extractor", Tier: "0-0" },
        { Name: "Constructor", Tier: "0-0" },
        { Name: "Packager", Tier: "0-0" },
      ],
      MultiMachines: [],
      Parts: [
        { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
        { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
        { Name: "FluidByproduct", Tier: "0-0", SinkPoints: 0, Fluid: true },
        { Name: "CarrierRaw", Tier: "0-0", SinkPoints: 0 },
        { Name: "Carrier", Tier: "0-0", SinkPoints: 0 },
        { Name: "PackagedFluid", Tier: "0-0", SinkPoints: 10 },
      ],
      Recipes: [
        { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
        {
          Name: "MainOutput",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "RawA", Amount: "-10" },
            { Part: "MainOutput", Amount: "5" },
            { Part: "FluidByproduct", Amount: "8" },
          ],
        },
        {
          Name: "CarrierRaw",
          Machine: "Extractor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [{ Part: "CarrierRaw", Amount: "60" }],
        },
        {
          Name: "Carrier",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "CarrierRaw", Amount: "-2" },
            { Part: "Carrier", Amount: "4" },
          ],
        },
        {
          Name: "Packaging",
          Machine: "Packager",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "FluidByproduct", Amount: "-2" },
            { Part: "Carrier", Amount: "-2" },
            { Part: "PackagedFluid", Amount: "2" },
          ],
        },
      ],
    });

    const plan = planFactory(fixture, [{ part: "MainOutput", rate: of(5) }], { handleByproducts: true });
    expect(plan.byproductDisposals[0]!.conversion?.supportChain?.part).toBe("Carrier");

    applyFactoryPlan(sfmDoc, root.id, plan);

    const nodes = listNodes(sfmDoc);
    const packagingNode = nodes.find((n) => n.recipe === "Packaging")!;
    const carrierNode = nodes.find((n) => n.recipe === "Carrier")!;
    const carrierRawNode = nodes.find((n) => n.recipe === "CarrierRaw")!;
    const sinkNode = nodes.find((n) => n.kind === "sink")!;
    expect(packagingNode).toBeDefined();
    expect(carrierNode).toBeDefined();
    expect(carrierRawNode).toBeDefined();

    const edges = listEdges(sfmDoc);
    // The support chain's own internal edge (CarrierRaw -> Carrier)...
    expect(edges).toContainEqual(
      expect.objectContaining({ part: "CarrierRaw", fromNode: carrierRawNode.id, toNode: carrierNode.id }),
    );
    // ...feeds the packaging machine's OWN carrier input port...
    expect(edges).toContainEqual(
      expect.objectContaining({
        part: "Carrier",
        fromNode: carrierNode.id,
        toNode: packagingNode.id,
        toPort: "in:Carrier",
      }),
    );
    // ...and the packaging machine's solid output reaches the sink.
    expect(edges).toContainEqual(
      expect.objectContaining({
        part: "PackagedFluid",
        fromNode: packagingNode.id,
        toNode: sinkNode.id,
        toPort: "in:*",
      }),
    );
  });

  it("wires reuse edges from a byproduct straight into the raw producer's existing consumer, alongside the shrunk producer's own edge", () => {
    const { sfmDoc, root } = setUp();
    const fixture = loadGameData({
      Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
      MultiMachines: [],
      Parts: [
        { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
        { Name: "RawB", Tier: "0-0", SinkPoints: 0 },
        { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
        { Name: "RecyclerOutput", Tier: "0-0", SinkPoints: 0 },
      ],
      Recipes: [
        { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
        { Name: "RawB", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawB", Amount: "60" }] },
        {
          Name: "MainOutput",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "RawA", Amount: "-10" },
            { Part: "MainOutput", Amount: "5" },
          ],
        },
        {
          Name: "Recycler",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "RawB", Amount: "-8" },
            { Part: "RecyclerOutput", Amount: "4" },
            { Part: "RawA", Amount: "6" },
          ],
        },
      ],
    });

    const plan = planFactory(
      fixture,
      [
        { part: "MainOutput", rate: of(5) },
        { part: "RecyclerOutput", rate: of(4) },
      ],
      { handleByproducts: true },
    );

    applyFactoryPlan(sfmDoc, root.id, plan);

    const nodes = listNodes(sfmDoc);
    const rawANode = nodes.find((n) => n.recipe === "RawA")!;
    const recyclerNode = nodes.find((n) => n.recipe === "Recycler")!;
    const mainOutputNode = nodes.find((n) => n.recipe === "MainOutput")!;

    // The raw producer's own limit reflects the shrunk machine count (see
    // `planFactory.test.ts`'s own math for this exact fixture).
    expect(rawANode.limit).toBe(toFractionString(of(1, 15)));

    const edges = listEdges(sfmDoc);
    // Its existing edge into MainOutput still exists...
    expect(edges).toContainEqual(
      expect.objectContaining({ part: "RawA", fromNode: rawANode.id, toNode: mainOutputNode.id }),
    );
    // ...alongside a NEW edge straight from the byproduct source.
    expect(edges).toContainEqual(
      expect.objectContaining({ part: "RawA", fromNode: recyclerNode.id, toNode: mainOutputNode.id, toPort: "in:RawA" }),
    );
    // Nothing left to dispose of — no sink created for this reuse.
    expect(listNodes(sfmDoc).some((n) => n.kind === "sink")).toBe(false);
  });

  it("creates no sink at all when handleByproducts is left off", () => {
    const { sfmDoc, root } = setUp();
    const plan = planFactory(gameData, [{ part: "Plastic", rate: of(20) }]);

    applyFactoryPlan(sfmDoc, root.id, plan);

    expect(listNodes(sfmDoc).some((n) => n.kind === "sink")).toBe(false);
  });

  it("creates a separate AWESOME Sink per byproduct instead of funneling the whole plan through one", () => {
    const { sfmDoc, root } = setUp();
    // MainOutput (RawA -> MainOutput, one step) and DeepOutput (RawA -> Mid
    // -> DeepOutput, two steps) each produce their own distinct byproduct at
    // a different generation — this is what should fan out into two sinks.
    const deepFixture = loadGameData({
      Machines: [{ Name: "Extractor", Tier: "0-0" }, { Name: "Constructor", Tier: "0-0" }],
      MultiMachines: [],
      Parts: [
        { Name: "RawA", Tier: "0-0", SinkPoints: 0 },
        { Name: "MainOutput", Tier: "0-0", SinkPoints: 0 },
        { Name: "Byproduct", Tier: "0-0", SinkPoints: 0 },
        { Name: "Mid", Tier: "0-0", SinkPoints: 0 },
        { Name: "DeepOutput", Tier: "0-0", SinkPoints: 0 },
        { Name: "Byproduct2", Tier: "0-0", SinkPoints: 0 },
      ],
      Recipes: [
        { Name: "RawA", Machine: "Extractor", BatchTime: "60", Tier: "0-0", Parts: [{ Part: "RawA", Amount: "60" }] },
        {
          Name: "MainOutput",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "RawA", Amount: "-10" },
            { Part: "MainOutput", Amount: "5" },
            { Part: "Byproduct", Amount: "3" },
          ],
        },
        {
          Name: "Mid",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "RawA", Amount: "-10" },
            { Part: "Mid", Amount: "5" },
          ],
        },
        {
          Name: "DeepOutput",
          Machine: "Constructor",
          BatchTime: "60",
          Tier: "0-0",
          Parts: [
            { Part: "Mid", Amount: "-5" },
            { Part: "DeepOutput", Amount: "4" },
            { Part: "Byproduct2", Amount: "2" },
          ],
        },
      ],
    });

    const plan = planFactory(
      deepFixture,
      [
        { part: "MainOutput", rate: of(5) },
        { part: "DeepOutput", rate: of(4) },
      ],
      { handleByproducts: true },
    );
    expect(plan.byproductDisposals).toHaveLength(2);

    applyFactoryPlan(sfmDoc, root.id, plan);

    const sinkNodes = listNodes(sfmDoc).filter((n) => n.kind === "sink");
    expect(sinkNodes).toHaveLength(2);
    // Distinct positions — not the same node reused for both disposals.
    expect(sinkNodes[0]!.x).not.toBe(sinkNodes[1]!.x);

    const edges = listEdges(sfmDoc);
    const byproductNode = sinkNodes.find((s) =>
      edges.some((e) => e.part === "Byproduct" && e.toNode === s.id),
    )!;
    const byproduct2Node = sinkNodes.find((s) =>
      edges.some((e) => e.part === "Byproduct2" && e.toNode === s.id),
    )!;
    expect(byproductNode.id).not.toBe(byproduct2Node.id);
  });

  it("routes a target's output to its own Dimensional Depot Uploader, limited to the requested rate", () => {
    const { sfmDoc, root } = setUp();
    const plan = planFactory(gameData, [{ part: "Iron Plate", rate: of(60) }], { routeOutputsToDepot: true });
    expect(plan.depotTargets).toEqual(["Iron Plate"]);

    applyFactoryPlan(sfmDoc, root.id, plan);

    const nodes = listNodes(sfmDoc);
    const depotNode = nodes.find((n) => n.kind === "depot");
    expect(depotNode).toBeDefined();
    expect(depotNode!.machine).toBe("Dimensional Depot Uploader");
    expect(depotNode!.limitMode).toBe("ppm");
    // Pinned to the requested rate, not left unlimited — same "every
    // generated node gets an exact value" convention the main chain's own
    // `limitMode: "machines"` nodes already follow.
    expect(depotNode!.limit).toBe(toFractionString(of(60)));

    const ironPlateNode = nodes.find((n) => n.recipe === "Iron Plate")!;
    expect(listEdges(sfmDoc)).toContainEqual(
      expect.objectContaining({
        part: "Iron Plate",
        fromNode: ironPlateNode.id,
        fromPort: "out:Iron Plate",
        toNode: depotNode!.id,
        toPort: "in:*",
      }),
    );
  });

  it("excludes a fluid target from Dimensional Depot routing", () => {
    const { sfmDoc, root } = setUp();
    // Water is a fluid (`@scm/gamedata`'s `Part.fluid`) — a Dimensional
    // Depot Uploader can't accept it, same restriction an AWESOME Sink has.
    const plan = planFactory(gameData, [{ part: "Water", rate: of(60) }], { routeOutputsToDepot: true });
    expect(plan.depotTargets).toEqual([]);

    applyFactoryPlan(sfmDoc, root.id, plan);

    expect(listNodes(sfmDoc).some((n) => n.kind === "depot")).toBe(false);
  });
});
