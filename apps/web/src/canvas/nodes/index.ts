// Public surface of Job 010's custom node components + their supporting
// pure logic. See jobs/010-recipe-node-ui.md's Handoff notes for the full
// contract (wire format for `limit`/`clock`, port handle id scheme, the
// `validityState` slot for Job 019).
export { RecipeNode } from "./RecipeNode";
export { SplurgerNode } from "./SplurgerNode";
export { SinkNode } from "./SinkNode";
export { StorageNode } from "./StorageNode";
export { RecipeNodeQuickSettings, type RecipeNodeQuickSettingsProps } from "./RecipeNodeQuickSettings";

export {
  CLOCK_PRESETS,
  MAX_CLOCK_PERCENT,
  MIN_CLOCK_PERCENT,
  clampClockPercent,
  clampShards,
  computeMachineCount,
  defaultLimitMode,
  deriveClockForTargetCount,
  effectiveClockPercent,
  effectiveLimitValue,
  floorToBigInt,
  isIntegerRational,
  primaryPart,
  ratePerMachineAtFullClock,
  referenceRateAtFullClock,
  stepClockToPreset,
  stopgapPartRate,
  type ClockNodeRef,
  type ClockSnapResult,
  type ClockStepDirection,
  type LimitNodeRef,
  type MachineRef,
} from "./recipeNodeMath";

export type { RecipeNodeValidity, RecipeNodeValidityState } from "./validityState";

export { computeNodeValidityState, type IncidentEdgeRef } from "./computeValidity";

// Job 027: Auto-round — see this module's own header for the "why does this
// converge instead of looping" argument, and `useAutoRound.ts`'s header for
// how "manually touching clock/limit switches it off" is implemented.
export { computeAutoRoundClock, nearestWholeMachineCount } from "./autoRound";
export { useAutoRound, AUTO_ROUND_ORIGIN } from "./useAutoRound";
