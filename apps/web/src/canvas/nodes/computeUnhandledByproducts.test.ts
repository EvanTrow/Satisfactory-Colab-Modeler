import type { RecipePart } from "@scm/gamedata";
import { of } from "@scm/rational";
import { describe, expect, it } from "vitest";

import { computeUnhandledByproducts } from "./computeUnhandledByproducts";

function part(name: string, amount: number): RecipePart {
  return { part: name, amount: of(amount) };
}

describe("computeUnhandledByproducts", () => {
  it("flags a byproduct with no outgoing edge", () => {
    const recipe = { parts: [part("Crude Oil", -30), part("Plastic", 20), part("Heavy Oil Residue", 10)] };
    expect(computeUnhandledByproducts(recipe, new Set())).toEqual(["Heavy Oil Residue"]);
  });

  it("doesn't flag a byproduct that already has an outgoing edge", () => {
    const recipe = { parts: [part("Crude Oil", -30), part("Plastic", 20), part("Heavy Oil Residue", 10)] };
    expect(computeUnhandledByproducts(recipe, new Set(["out:Heavy Oil Residue"]))).toEqual([]);
  });

  it("never flags the primary output, connected or not", () => {
    const recipe = { parts: [part("Crude Oil", -30), part("Plastic", 20), part("Heavy Oil Residue", 10)] };
    // Plastic (the larger-magnitude positive part, i.e. the primary output)
    // is left completely unconnected here — still not flagged.
    expect(computeUnhandledByproducts(recipe, new Set(["out:Heavy Oil Residue"]))).toEqual([]);
  });

  it("never flags an input part", () => {
    const recipe = { parts: [part("Crude Oil", -30), part("Plastic", 20)] };
    expect(computeUnhandledByproducts(recipe, new Set())).toEqual([]);
  });

  it("returns [] for a recipe with no byproducts at all (single output)", () => {
    const recipe = { parts: [part("Iron Ore", -1), part("Iron Ingot", 1)] };
    expect(computeUnhandledByproducts(recipe, new Set())).toEqual([]);
  });

  it("returns [] for a recipe with no parts", () => {
    expect(computeUnhandledByproducts({ parts: [] }, new Set())).toEqual([]);
  });

  it("reports multiple unconnected byproducts independently, each still excluding the primary output", () => {
    const recipe = {
      parts: [part("RawA", -10), part("MainOutput", 5), part("ByproductA", 3), part("ByproductB", 2)],
    };
    expect([...computeUnhandledByproducts(recipe, new Set())].sort()).toEqual(["ByproductA", "ByproductB"]);
    expect(computeUnhandledByproducts(recipe, new Set(["out:ByproductA"]))).toEqual(["ByproductB"]);
  });
});
