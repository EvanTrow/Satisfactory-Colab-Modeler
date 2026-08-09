import { add, equals, of, ZERO, type Rational } from "@scm/rational";
import { describe, expect, it } from "vitest";
import { groupConnectedComponents, jointMaxMinFairFlow, type JointFlowEdge } from "./jointFlow";

function totals(pairs: [string, number][]): Map<string, Rational> {
  return new Map(pairs.map(([k, v]) => [k, of(v)] as const));
}

function rateOf(result: ReturnType<typeof jointMaxMinFairFlow>, edgeId: string): Rational {
  return result.rate.get(edgeId)!;
}

describe("jointMaxMinFairFlow", () => {
  it("single source, single target: the whole amount flows through the one edge", () => {
    const edges: JointFlowEdge[] = [{ id: "e1", from: "src:a", to: "tgt:b" }];
    const result = jointMaxMinFairFlow(totals([["src:a", 60], ["tgt:b", 60]]), edges);
    expect(equals(rateOf(result, "e1"), of(60))).toBe(true);
    expect(result.shortfall.size).toBe(0);
  });

  it("one source splitting to two single-edge targets at different demands (no adjacent merger) matches the existing per-group behavior", () => {
    const edges: JointFlowEdge[] = [
      { id: "e1", from: "src:a", to: "tgt:small" },
      { id: "e2", from: "src:a", to: "tgt:big" },
    ];
    const result = jointMaxMinFairFlow(totals([["src:a", 60], ["tgt:small", 20], ["tgt:big", 40]]), edges);
    expect(equals(rateOf(result, "e1"), of(20))).toBe(true);
    expect(equals(rateOf(result, "e2"), of(40))).toBe(true);
    expect(result.shortfall.size).toBe(0);
  });

  it("the reported byproduct-reuse bug: two independent sources both feed a small and a large consumer", () => {
    // raw=16290, scrap=7695 (total 23985); small=900, big=23085 (total 23985) — exactly the live repro's numbers.
    const edges: JointFlowEdge[] = [
      { id: "raw->small", from: "src:raw", to: "tgt:small" },
      { id: "raw->big", from: "src:raw", to: "tgt:big" },
      { id: "scrap->small", from: "src:scrap", to: "tgt:small" },
      { id: "scrap->big", from: "src:scrap", to: "tgt:big" },
    ];
    const result = jointMaxMinFairFlow(
      totals([
        ["src:raw", 16290],
        ["src:scrap", 7695],
        ["tgt:small", 900],
        ["tgt:big", 23085],
      ]),
      edges,
    );

    expect(result.shortfall.size).toBe(0); // totals balance exactly — everyone should be fully satisfied

    const sumRates = (ids: string[]) => ids.reduce((sum, id) => add(sum, result.rate.get(id)!), ZERO);

    expect(equals(sumRates(["raw->small", "scrap->small"]), of(900))).toBe(true);
    expect(equals(sumRates(["raw->big", "scrap->big"]), of(23085))).toBe(true);
    expect(equals(sumRates(["raw->small", "raw->big"]), of(16290))).toBe(true);
    expect(equals(sumRates(["scrap->small", "scrap->big"]), of(7695))).toBe(true);

    // And precisely: no edge is starved into a value that doesn't reconcile —
    // matches the hand-derived trace in this fix's investigation.
    expect(equals(result.rate.get("raw->small")!, of(450))).toBe(true);
    expect(equals(result.rate.get("scrap->small")!, of(450))).toBe(true);
    expect(equals(result.rate.get("scrap->big")!, of(7245))).toBe(true);
    expect(equals(result.rate.get("raw->big")!, of(15840))).toBe(true);
  });

  it("genuine oversupply: a source with more than every target combined needs reports shortfall on the SOURCE side", () => {
    const edges: JointFlowEdge[] = [{ id: "e1", from: "src:a", to: "tgt:b" }];
    const result = jointMaxMinFairFlow(totals([["src:a", 100], ["tgt:b", 60]]), edges);
    expect(equals(rateOf(result, "e1"), of(60))).toBe(true); // target fully satisfied
    expect(equals(result.shortfall.get("src:a")!, of(40))).toBe(true); // source has 40 leftover, unrouted
    expect(result.shortfall.has("tgt:b")).toBe(false);
  });

  it("genuine undersupply: a target needing more than every source combined provides reports shortfall on the TARGET side", () => {
    const edges: JointFlowEdge[] = [{ id: "e1", from: "src:a", to: "tgt:b" }];
    const result = jointMaxMinFairFlow(totals([["src:a", 40], ["tgt:b", 100]]), edges);
    expect(equals(rateOf(result, "e1"), of(40))).toBe(true);
    expect(equals(result.shortfall.get("tgt:b")!, of(60))).toBe(true);
    expect(result.shortfall.has("src:a")).toBe(false);
  });

  it("a node acting as both a source and a target for the same part uses two distinct keys, not one", () => {
    // Node "n" both consumes 10 from "a" (as a target) and produces 10 to "b" (as a source) —
    // caller is responsible for the src:/tgt: disambiguation; verifies the algorithm itself
    // doesn't secretly require source/target keys to be from disjoint pools beyond what's given.
    const edges: JointFlowEdge[] = [
      { id: "a->n", from: "src:a", to: "tgt:n" },
      { id: "n->b", from: "src:n", to: "tgt:b" },
    ];
    const result = jointMaxMinFairFlow(
      totals([
        ["src:a", 10],
        ["tgt:n", 10],
        ["src:n", 10],
        ["tgt:b", 10],
      ]),
      edges,
    );
    expect(equals(rateOf(result, "a->n"), of(10))).toBe(true);
    expect(equals(rateOf(result, "n->b"), of(10))).toBe(true);
    expect(result.shortfall.size).toBe(0);
  });

  it("three-way split/merge (three sources, two targets) still balances exactly when totals match", () => {
    const edges: JointFlowEdge[] = [
      { id: "s1->t1", from: "src:s1", to: "tgt:t1" },
      { id: "s1->t2", from: "src:s1", to: "tgt:t2" },
      { id: "s2->t1", from: "src:s2", to: "tgt:t1" },
      { id: "s2->t2", from: "src:s2", to: "tgt:t2" },
      { id: "s3->t1", from: "src:s3", to: "tgt:t1" },
      { id: "s3->t2", from: "src:s3", to: "tgt:t2" },
    ];
    const result = jointMaxMinFairFlow(
      totals([
        ["src:s1", 30],
        ["src:s2", 30],
        ["src:s3", 30],
        ["tgt:t1", 10],
        ["tgt:t2", 80],
      ]),
      edges,
    );
    expect(result.shortfall.size).toBe(0);
    const t1total = ["s1->t1", "s2->t1", "s3->t1"].reduce((sum, id) => add(sum, result.rate.get(id)!), ZERO);
    const t2total = ["s1->t2", "s2->t2", "s3->t2"].reduce((sum, id) => add(sum, result.rate.get(id)!), ZERO);
    expect(equals(t1total, of(10))).toBe(true);
    expect(equals(t2total, of(80))).toBe(true);
  });

  it("determinism: shuffled edge input order produces identical rates", () => {
    const edgesA: JointFlowEdge[] = [
      { id: "raw->small", from: "src:raw", to: "tgt:small" },
      { id: "raw->big", from: "src:raw", to: "tgt:big" },
      { id: "scrap->small", from: "src:scrap", to: "tgt:small" },
      { id: "scrap->big", from: "src:scrap", to: "tgt:big" },
    ];
    const edgesB = [...edgesA].reverse();
    const t = totals([
      ["src:raw", 16290],
      ["src:scrap", 7695],
      ["tgt:small", 900],
      ["tgt:big", 23085],
    ]);
    const resultA = jointMaxMinFairFlow(t, edgesA);
    const resultB = jointMaxMinFairFlow(t, edgesB);
    for (const id of ["raw->small", "raw->big", "scrap->small", "scrap->big"]) {
      expect(equals(resultA.rate.get(id)!, resultB.rate.get(id)!)).toBe(true);
    }
  });
});

describe("groupConnectedComponents", () => {
  it("splits unrelated edges into separate components", () => {
    const edges: JointFlowEdge[] = [
      { id: "e1", from: "src:a", to: "tgt:b" },
      { id: "e2", from: "src:c", to: "tgt:d" },
    ];
    const components = groupConnectedComponents(edges);
    expect(components).toHaveLength(2);
    expect(components.flat().map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });

  it("keeps a diamond (2 sources x 2 targets) as one component", () => {
    const edges: JointFlowEdge[] = [
      { id: "e1", from: "src:a", to: "tgt:x" },
      { id: "e2", from: "src:a", to: "tgt:y" },
      { id: "e3", from: "src:b", to: "tgt:x" },
      { id: "e4", from: "src:b", to: "tgt:y" },
    ];
    const components = groupConnectedComponents(edges);
    expect(components).toHaveLength(1);
    expect(components[0]).toHaveLength(4);
  });

  it("is order-independent", () => {
    const edges: JointFlowEdge[] = [
      { id: "e1", from: "src:a", to: "tgt:x" },
      { id: "e2", from: "src:b", to: "tgt:y" },
      { id: "e3", from: "src:a", to: "tgt:y" },
    ];
    const componentsA = groupConnectedComponents(edges);
    const componentsB = groupConnectedComponents([...edges].reverse());
    expect(componentsA.map((c) => c.map((e) => e.id).sort())).toEqual(componentsB.map((c) => c.map((e) => e.id).sort()));
  });
});
