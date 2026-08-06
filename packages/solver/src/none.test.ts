// None mode: PLAN.md §2's table — nothing computed, instant.
import { defaultGameData } from "@scm/gamedata";
import { describe, expect, it } from "vitest";
import { solve } from "./index";
import type { SolverSnapshot } from "./snapshot";

describe("None mode", () => {
  it("computes nothing, regardless of graph size", () => {
    const snapshot: SolverSnapshot = {
      nodes: [
        {
          id: "n",
          recipe: "Iron Ingot",
          machine: "Smelter",
          purity: null,
          limit: "5",
          limitMode: "machines",
          clock: null,
          shards: 0,
        },
      ],
      edges: [],
    };
    const result = solve(snapshot, "none", defaultGameData);
    expect(result.mode).toBe("none");
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.summary.perPart).toEqual({});
    expect(result.valid).toBe(true);
  });
});
