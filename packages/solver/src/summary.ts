// Graph-wide summary aggregates — PLAN.md §2/§3's "made/used/unmade/unused,
// power made/used/net, sink points" summary panel data. Deliberately a pure
// production/consumption BALANCE over every node in the snapshot, not a
// flow-through-edges computation: this matches how the original tool's
// summary reads (total made vs total used for each part, regardless of
// whether every unit is actually wired up), and it means the summary stays
// meaningful even for a graph with dangling ports (an unconnected output is
// "made" but "unused"; an unconnected input is "used" but was never "made"
// by anything -> "unmade").
import { ZERO, abs, add, compare, isPositive, isZero, subtract, toFractionString, type Rational } from "@scm/rational";
import { nodePower, partRateAtMachineCount, type NodeProfile } from "./nodeProfile";
import type { PartBalance, SolveSummary } from "./result";

export function computeSummary(
  nodeIds: readonly string[],
  profiles: ReadonlyMap<string, NodeProfile>,
  counts: ReadonlyMap<string, Rational>,
): SolveSummary {
  const made = new Map<string, Rational>();
  const used = new Map<string, Rational>();
  let powerMade = 0;
  let powerUsed = 0;

  for (const nodeId of nodeIds) {
    const profile = profiles.get(nodeId);
    const count = counts.get(nodeId);
    if (!profile?.recipe || count === undefined) continue;

    for (const part of profile.recipe.parts) {
      const rate = partRateAtMachineCount(profile, part.part, count);
      if (isZero(rate)) continue;
      if (isPositive(rate)) {
        made.set(part.part, add(made.get(part.part) ?? ZERO, rate));
      } else {
        used.set(part.part, add(used.get(part.part) ?? ZERO, abs(rate)));
      }
    }

    const power = nodePower(profile, count);
    if (power > 0) powerMade += power;
    else powerUsed += -power;
  }

  const partNames = [...new Set([...made.keys(), ...used.keys()])].sort();
  const perPart: Record<string, PartBalance> = {};
  for (const part of partNames) {
    const madeAmount = made.get(part) ?? ZERO;
    const usedAmount = used.get(part) ?? ZERO;
    const unmade = compare(usedAmount, madeAmount) > 0 ? subtract(usedAmount, madeAmount) : ZERO;
    const unused = compare(madeAmount, usedAmount) > 0 ? subtract(madeAmount, usedAmount) : ZERO;
    perPart[part] = {
      made: toFractionString(madeAmount),
      used: toFractionString(usedAmount),
      unmade: toFractionString(unmade),
      unused: toFractionString(unused),
    };
  }

  return {
    perPart,
    powerMade,
    powerUsed,
    powerNet: powerMade - powerUsed,
    // AWESOME Sink has no snapshot representation yet — see result.ts.
    sinkPoints: "0",
  };
}
