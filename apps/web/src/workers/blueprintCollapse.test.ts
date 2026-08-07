// Job 026 (Blueprints, PLAN.md §10.3) — the full glue-layer pipeline this
// job built: collapsing a real `kind: "blueprint"` container's internal
// recipe subgraph into a compound `SolverNode`, running it through a real
// `solve()` call, and expanding the result back into correctly-scaled
// per-internal-node/edge entries. `blueprint.test.ts` in `packages/solver`
// already proves the CORE solver-level semantics (a compound node's
// machine count resolves jointly with the rest of the graph); this file
// proves the CONTAINER-AWARE wiring around it — the part that only exists
// in `apps/web`, since `packages/solver` has no container concept at all.
import { addContainer, addEdge, addNode, createDocument, listContainers, listNodes, updateContainer, type SfmDocument } from "@scm/ydoc";
import { solve } from "@scm/solver";
import { defaultGameData } from "@scm/gamedata";
import { equals, of, parseRational } from "@scm/rational";
import { describe, expect, it } from "vitest";

import { blueprintCompoundNodeId, collapseBlueprints, expandBlueprintResults } from "./blueprintCollapse";
import { buildSolverSnapshot, buildSolverSnapshotWithBlueprints } from "./buildSnapshot";
import { mergeComponentResults } from "./mergeResults";

function recipeNode(
  sfmDoc: SfmDocument,
  containerId: string,
  overrides: Partial<Parameters<typeof addNode>[1]> = {},
) {
  return addNode(sfmDoc, {
    containerId,
    kind: "recipe",
    recipe: "Iron Ore",
    machine: "Miner Mk.1",
    x: 0,
    y: 0,
    title: "node",
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

/** Builds: root -> blueprint(Miner --Iron Ore--> Smelter) --Iron Ingot--> external Constructor (outside the blueprint). */
function buildFixture() {
  const sfmDoc = createDocument();
  const root = "root";
  addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });
  const blueprint = addContainer(sfmDoc, {
    kind: "blueprint",
    parentId: root,
    title: "Smelting Blueprint",
    color: "#f80",
    x: 0,
    y: 0,
    copiesLimit: null,
  });

  const miner = recipeNode(sfmDoc, blueprint.id, {
    recipe: "Iron Ore",
    machine: "Miner Mk.1",
    purity: "normal",
    limit: "15",
    limitMode: "ppm",
    title: "Miner",
  });
  const smelter = recipeNode(sfmDoc, blueprint.id, {
    recipe: "Iron Ingot",
    machine: "Smelter",
    title: "Smelter",
  });
  const assembler = recipeNode(sfmDoc, root, {
    recipe: "Iron Plate",
    machine: "Constructor",
    limit: "2",
    limitMode: "machines",
    title: "Constructor",
  });

  const internalEdge = addEdge(sfmDoc, {
    containerId: blueprint.id,
    part: "Iron Ore",
    fromNode: miner.id,
    fromPort: "out:Iron Ore",
    toNode: smelter.id,
    toPort: "in:Iron Ore",
    style: null,
    labelPos: null,
  });
  const crossingEdge = addEdge(sfmDoc, {
    containerId: blueprint.id,
    part: "Iron Ingot",
    fromNode: smelter.id,
    fromPort: "out:Iron Ingot",
    toNode: assembler.id,
    toPort: "in:Iron Ingot",
    style: null,
    labelPos: null,
  });

  return { sfmDoc, root, blueprint, miner, smelter, assembler, internalEdge, crossingEdge };
}

describe("collapseBlueprints", () => {
  it("is a no-op (byte-identical snapshot, no blueprints) for a document with no blueprint container at all", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });
    recipeNode(sfmDoc, root, { recipe: "Iron Ore", machine: "Miner Mk.1", purity: "normal" });

    const raw = buildSolverSnapshot(sfmDoc);
    const collapsed = collapseBlueprints(listContainers(sfmDoc), listNodes(sfmDoc), raw, "basic", defaultGameData);
    expect(collapsed.blueprints).toHaveLength(0);
    expect(collapsed.snapshot).toEqual(raw);
  });

  it("in None/Manual mode, leaves internal nodes uncollapsed (blueprints have no 'infer from graph' concept in either mode)", () => {
    const { sfmDoc } = buildFixture();
    const raw = buildSolverSnapshot(sfmDoc);
    for (const mode of ["none", "manual"] as const) {
      const collapsed = collapseBlueprints(listContainers(sfmDoc), listNodes(sfmDoc), raw, mode, defaultGameData);
      expect(collapsed.blueprints).toHaveLength(0);
      expect(collapsed.snapshot).toEqual(raw);
    }
  });

  it("Basic mode: replaces the blueprint's internal nodes/edges with one compound node, rewrites the crossing edge, and computes correct one-copy per-copy rates", () => {
    const { sfmDoc, blueprint, miner, smelter, assembler, internalEdge, crossingEdge } = buildFixture();
    const raw = buildSolverSnapshot(sfmDoc);
    const { snapshot, blueprints } = collapseBlueprints(listContainers(sfmDoc), listNodes(sfmDoc), raw, "basic", defaultGameData);

    const compoundId = blueprintCompoundNodeId(blueprint.id);
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual([assembler.id, compoundId].sort());
    expect(snapshot.edges).toHaveLength(1);
    const rewritten = snapshot.edges[0]!;
    expect(rewritten.id).toBe(crossingEdge.id); // real edge id preserved -> validity highlighting still resolves by real id.
    expect(rewritten.fromNode).toBe(compoundId);
    expect(rewritten.toNode).toBe(assembler.id);
    expect(rewritten.part).toBe("Iron Ingot");

    const compound = snapshot.nodes.find((n) => n.id === compoundId)!;
    // One copy of the blueprint (Miner pinned at 15 Iron Ore/min) makes 15
    // Iron Ingot/min (1:1 Smelter recipe) available to cross the boundary.
    expect(compound.blueprintCopyBasis?.perCopyRates["Iron Ingot"]).toBe(toN(15));

    expect(blueprints).toHaveLength(1);
    const bp = blueprints[0]!;
    expect(bp.containerId).toBe(blueprint.id);
    expect(bp.compoundNodeId).toBe(compoundId);
    // The internal edge (Miner -> Smelter) has its own one-copy result kept
    // for later expansion; the crossing edge does NOT (it already has a
    // real entry in the outer result under its own real id).
    expect(bp.perCopy.edges.map((e) => e.edgeId)).toEqual([internalEdge.id]);
    expect(bp.perCopy.nodes.map((n) => n.nodeId).sort()).toEqual([miner.id, smelter.id].sort());
  });

  it("detects and skips a nested blueprint (a blueprint inside a blueprint) rather than collapsing either incorrectly", () => {
    const { sfmDoc, blueprint } = buildFixture();
    const nested = addContainer(sfmDoc, {
      kind: "blueprint",
      parentId: blueprint.id,
      title: "Nested",
      color: "#00f",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    recipeNode(sfmDoc, nested.id, { recipe: "Iron Ore", machine: "Miner Mk.1", purity: "normal" });

    const raw = buildSolverSnapshot(sfmDoc);
    const { blueprints, skippedNestedBlueprintIds } = collapseBlueprints(
      listContainers(sfmDoc),
      listNodes(sfmDoc),
      raw,
      "basic",
      defaultGameData,
    );
    expect(blueprints).toHaveLength(0);
    expect(new Set(skippedNestedBlueprintIds)).toEqual(new Set([blueprint.id, nested.id]));
  });

  it("Container.copiesLimit is encoded as a literal machine-count pin on the compound node", () => {
    const { sfmDoc, blueprint } = buildFixture();
    updateContainer(sfmDoc, blueprint.id, { copiesLimit: 3 });
    const raw = buildSolverSnapshot(sfmDoc);
    const { snapshot } = collapseBlueprints(listContainers(sfmDoc), listNodes(sfmDoc), raw, "basic", defaultGameData);
    const compound = snapshot.nodes.find((n) => n.id === blueprintCompoundNodeId(blueprint.id))!;
    expect(compound.limit).toBe("3");
    expect(compound.limitMode).toBe("machines");
  });
});

describe("buildSolverSnapshotWithBlueprints + expandBlueprintResults — full pipeline through a real solve()", () => {
  it("computes the copy count from real external demand and scales every internal node/edge's displayed values consistently with it", () => {
    const { sfmDoc, blueprint, miner, smelter, internalEdge, crossingEdge } = buildFixture();
    const { snapshot, blueprints } = buildSolverSnapshotWithBlueprints(sfmDoc, "basic", defaultGameData);

    const rawResult = solve(snapshot, "basic", defaultGameData);
    const result = expandBlueprintResults(rawResult, blueprints, mergeComponentResults);

    // The Constructor (2 machines, Iron Plate recipe: -3 Iron Ingot / +2
    // Iron Plate per 6s batch) demands 2 * 30 = 60 Iron Ingot/min. One copy
    // of the blueprint supplies 15/min -> copies = 60 / 15 = 4.
    const compound = result.nodes.find((n) => n.nodeId === blueprintCompoundNodeId(blueprint.id))!;
    expect(equals(parseRational(compound.machineCount), of(4))).toBe(true);
    expect(compound.resolved).toBe(true);

    // Every internal node's displayed value is its OWN one-copy value times
    // the solved copy count — this is the acceptance-criteria-mandated
    // "internal per-copy quantities consistent with [the copy count]" check.
    const smelterResult = result.nodes.find((n) => n.nodeId === smelter.id)!;
    expect(equals(parseRational(smelterResult.machineCount), of(2))).toBe(true); // 0.5 * 4
    expect(equals(parseRational(smelterResult.partRates["Iron Ingot"]!), of(60))).toBe(true); // 15 * 4
    expect(equals(parseRational(smelterResult.partRates["Iron Ore"]!), of(-60))).toBe(true);

    const minerResult = result.nodes.find((n) => n.nodeId === miner.id)!;
    expect(equals(parseRational(minerResult.partRates["Iron Ore"]!), of(60))).toBe(true); // 15 * 4

    // The internal (Miner -> Smelter) edge and the real crossing (Smelter ->
    // Constructor) edge both report the fully-scaled rate, both valid.
    const internal = result.edges.find((e) => e.edgeId === internalEdge.id)!;
    expect(equals(parseRational(internal.rate), of(60))).toBe(true);
    expect(internal.valid).toBe(true);

    const crossing = result.edges.find((e) => e.edgeId === crossingEdge.id)!;
    expect(equals(parseRational(crossing.rate), of(60))).toBe(true);
    expect(crossing.valid).toBe(true);

    // The document-wide summary reflects the REAL internal-only balance
    // (Iron Ore made == used, both 60/min) — not just the compound's own
    // boundary-only aggregate, which never mentions Iron Ore at all.
    expect(result.summary.perPart["Iron Ore"]?.made).toBe(toN(60));
    expect(result.summary.perPart["Iron Ore"]?.used).toBe(toN(60));
    expect(result.summary.perPart["Iron Ingot"]?.made).toBe(toN(60));
    expect(result.summary.perPart["Iron Ingot"]?.used).toBe(toN(60));
    expect(result.valid).toBe(true);

    // The compound's own entry is STILL present (for the blueprint card's
    // "Copies: 4" display from the parent view) even though it's excluded
    // from the summary aggregation above.
    expect(result.nodes.some((n) => n.nodeId === blueprintCompoundNodeId(blueprint.id))).toBe(true);
  });

  it("a document with no blueprint container produces an unchanged result through the same pipeline", () => {
    const sfmDoc = createDocument();
    const root = "root";
    addContainer(sfmDoc, { id: root, kind: "root", parentId: null, title: "Root", color: "#000", x: 0, y: 0, copiesLimit: null });
    recipeNode(sfmDoc, root, { recipe: "Iron Ore", machine: "Miner Mk.1", purity: "normal", limit: "30", limitMode: "ppm" });

    const { snapshot, blueprints } = buildSolverSnapshotWithBlueprints(sfmDoc, "basic", defaultGameData);
    const rawResult = solve(snapshot, "basic", defaultGameData);
    const result = expandBlueprintResults(rawResult, blueprints, mergeComponentResults);
    expect(result).toEqual(rawResult);
  });
});

function toN(n: number): string {
  return String(n);
}
