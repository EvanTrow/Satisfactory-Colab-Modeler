// Turns a resolved `(NodeProfile, machineCount)` pair into the public
// `NodeSolveResult` shape. Shared by `manual.ts` and `basic.ts` so the two
// modes can never drift on what counts as "valid" or how partRates/power
// are reported.
import { isPositive, toFractionString, type Rational } from "@scm/rational";
import { nodePower, partRateAtMachineCount, type NodeProfile } from "./nodeProfile";
import type { NodeSolveResult } from "./result";

/**
 * The direction-prefixed key `NodeSolveResult.partRatesByDirection` uses for
 * every part entry — same `"in:"`/`"out:"` convention the web app already
 * uses for port/handle ids (`partHandleId`) and generated edges'
 * `fromPort`/`toPort` (`applyFactoryPlan.ts`), reused here so a consumer
 * that already knows which side of a node it means can ask for it
 * unambiguously. Exported so `apps/web` doesn't have to duplicate the exact
 * prefix strings.
 */
export function partRateKey(part: string, amount: Rational): string {
  return `${isPositive(amount) ? "out" : "in"}:${part}`;
}

export function buildNodeResult(
  nodeId: string,
  profile: NodeProfile,
  machineCount: Rational,
  resolved: boolean,
  extraIssues: readonly string[] = [],
  forceInvalid = false,
): NodeSolveResult {
  const partRates: Record<string, string> = {};
  const partRatesByDirection: Record<string, string> = {};
  if (profile.recipe) {
    for (const part of profile.recipe.parts) {
      const direction = isPositive(part.amount) ? "output" : "input";
      const rate = toFractionString(partRateAtMachineCount(profile, part.part, machineCount, direction));
      // Bare name: first-match-wins, matching `refRatePerPart` — unchanged
      // for every recipe that doesn't list a part twice (the overwhelming
      // majority), and kept for backward compatibility (every existing
      // consumer/test reads this key, including aggregate consumers that
      // iterate every key in this object as if it were a real part name)
      // even for the rare recipe that does.
      if (!(part.part in partRates)) partRates[part.part] = rate;
      // Direction-prefixed, in the SEPARATE `partRatesByDirection` map —
      // always correct, even for a duplicated name — see `partRateKey`'s
      // own doc comment and `NodeSolveResult.partRatesByDirection`'s.
      partRatesByDirection[partRateKey(part.part, part.amount)] = rate;
    }
  }

  return {
    nodeId,
    machineCount: toFractionString(machineCount),
    clockPercent: toFractionString(profile.clockPercent),
    resolved,
    partRates,
    partRatesByDirection,
    power: nodePower(profile, machineCount),
    valid: profile.issues.length === 0 && !forceInvalid,
    issues: [...profile.issues, ...extraIssues],
  };
}
