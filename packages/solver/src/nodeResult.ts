// Turns a resolved `(NodeProfile, machineCount)` pair into the public
// `NodeSolveResult` shape. Shared by `manual.ts` and `basic.ts` so the two
// modes can never drift on what counts as "valid" or how partRates/power
// are reported.
import { toFractionString, type Rational } from "@scm/rational";
import { nodePower, partRateAtMachineCount, type NodeProfile } from "./nodeProfile";
import type { NodeSolveResult } from "./result";

export function buildNodeResult(
  nodeId: string,
  profile: NodeProfile,
  machineCount: Rational,
  resolved: boolean,
  extraIssues: readonly string[] = [],
  forceInvalid = false,
): NodeSolveResult {
  const partRates: Record<string, string> = {};
  if (profile.recipe) {
    for (const part of profile.recipe.parts) {
      partRates[part.part] = toFractionString(partRateAtMachineCount(profile, part.part, machineCount));
    }
  }

  return {
    nodeId,
    machineCount: toFractionString(machineCount),
    clockPercent: toFractionString(profile.clockPercent),
    resolved,
    partRates,
    power: nodePower(profile, machineCount),
    valid: profile.issues.length === 0 && !forceInvalid,
    issues: [...profile.issues, ...extraIssues],
  };
}
