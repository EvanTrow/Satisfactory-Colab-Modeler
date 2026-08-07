// Public surface of Job 010's custom node components + their supporting
// pure logic. See jobs/010-recipe-node-ui.md's Handoff notes for the full
// contract (wire format for `limit`/`clock`, port handle id scheme, the
// `validityState` slot for Job 019).
export { RecipeNode } from "./RecipeNode";

export {
  MAX_CLOCK_PERCENT,
  MIN_CLOCK_PERCENT,
  clampClockPercent,
  clampShards,
  computeMachineCount,
  defaultLimitMode,
  effectiveClockPercent,
  effectiveLimitValue,
  primaryPart,
  ratePerMachineAtFullClock,
  referenceRateAtFullClock,
  snapClockToWholeMachineCount,
  stopgapPartRate,
  type ClockNodeRef,
  type ClockSnapDirection,
  type ClockSnapResult,
  type LimitNodeRef,
  type MachineRef,
} from "./recipeNodeMath";

export type { RecipeNodeValidity, RecipeNodeValidityState } from "./validityState";

export { computeNodeValidityState, type IncidentEdgeRef } from "./computeValidity";
