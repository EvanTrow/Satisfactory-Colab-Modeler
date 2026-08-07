// Public API of `@scm/gamedata`. See PLAN.md §1 and §7, and
// jobs/003-gamedata-package.md's Handoff notes for the full picture.
export type {
  CostEntry,
  GameData,
  Machine,
  MultiMachine,
  MultiMachineCapacity,
  MultiMachineModel,
  MultiMachineRatioKind,
  Part,
  Recipe,
  RecipePart,
  Tier,
} from "./types.js";

export {
  type RawGameData,
  type RawMachine,
  type RawMultiMachine,
  type RawPart,
  type RawRecipe,
  RawGameDataSchema,
  RawMachineSchema,
  RawMultiMachineSchema,
  RawPartSchema,
  RawRecipeSchema,
} from "./schema.js";

export { GAME_DATA_VERSION, loadGameData } from "./load.js";

export { type RecipeIndices, buildRecipeIndices, compareTiers, parseTier } from "./indices.js";

export {
  MULTI_MACHINE_RECIPE_NAMES,
  type MultiMachineVariant,
  type ResolvedMachine,
  type ResolvedMultiMachine,
  type ResolvedPlainMachine,
  baseRecipeRatePerMinute,
  defaultVariant,
  findVariant,
  multiMachineRecipeRatePerMinute,
  resolveMachine,
} from "./machines.js";

export { type SomersloopBoost, somersloopBoost } from "./somersloop.js";

export {
  KNOWN_NON_ENTITY_ICON_FILES,
  type IconCoverageResult,
  iconFileName,
  verifyIconCoverage,
} from "./icons.js";

export { defaultGameData } from "./data.js";
