// `Recipe.Machine` resolution against the union of `Machines` and
// `MultiMachines`, per PLAN.md §1: five names resolve to `MultiMachines`
// (which cross a model list against a capacity list, e.g. Miner Mk.3 ×
// Pure); every other name resolves to a plain `Machines` entry.
import { ONE, divide, multiply, of, type Rational } from "@scm/rational";
import type {
  GameData,
  Machine,
  MultiMachine,
  MultiMachineCapacity,
  MultiMachineModel,
  MultiMachineRatioKind,
  Recipe,
} from "./types.js";

/**
 * The five `Recipe.Machine` values that resolve against `MultiMachines`
 * instead of `Machines`. `MultiMachines` also contains `AWESOME Sink` and
 * `Dimensional Depot Uploader`, but no recipe's `Machine` field is ever one
 * of those two names — they're specialty node types (PLAN.md §2), not
 * recipe machines — so they fall through to a plain `Machines` lookup like
 * everything else, and that lookup succeeds because both names also have a
 * flat `Machines` entry (holding their cost/tier/power data).
 */
export const MULTI_MACHINE_RECIPE_NAMES: ReadonlySet<string> = new Set([
  "Miner",
  "Oil Extractor",
  "Resource Well Extractor",
  "Geothermal Generator",
  "Space Elevator",
]);

export interface MultiMachineVariant {
  readonly multiMachineName: string;
  /** The model variant (e.g. "Miner Mk.3"), when the family has models. */
  readonly model?: MultiMachineModel;
  /** The capacity variant (e.g. "Pure"), when the family has capacities. */
  readonly capacity?: MultiMachineCapacity;
  /** Base stats (AveragePower, OverclockPowerExponent, Cost, ...) for this variant. */
  readonly machine: Machine;
  /**
   * Combined multiplier: `(model?.partsRatio ?? 1) × (capacity's ratio ?? 1)`.
   * Multiply a recipe's base per-minute rate (see `baseRecipeRatePerMinute`)
   * by this to get the variant's actual rate — this is the "1 × 240 × 2 =
   * 480" computation from PLAN.md §1's Miner Mk.3-on-Pure example.
   */
  readonly ratio: Rational;
  readonly ratioKind: MultiMachineRatioKind;
  readonly isDefaultModel: boolean;
  readonly isDefaultCapacity: boolean;
}

export interface ResolvedPlainMachine {
  readonly kind: "machine";
  readonly machine: Machine;
}

export interface ResolvedMultiMachine {
  readonly kind: "multiMachine";
  readonly name: string;
  readonly multiMachine: MultiMachine;
  /** The full model × capacity crossing. Length is `max(1, models.length) × max(1, capacities.length)`. */
  readonly variants: readonly MultiMachineVariant[];
}

export type ResolvedMachine = ResolvedPlainMachine | ResolvedMultiMachine;

function requireMachine(gameData: GameData, name: string): Machine {
  const machine = gameData.machinesByName.get(name);
  if (!machine) {
    throw new Error(`Machine "${name}" not found in game data`);
  }
  return machine;
}

function capacityRatio(capacity: MultiMachineCapacity | undefined): Rational {
  if (!capacity) return ONE;
  return capacity.partsRatio ?? capacity.powerRatio ?? ONE;
}

function buildVariants(gameData: GameData, multiMachine: MultiMachine): MultiMachineVariant[] {
  const models = multiMachine.models.length > 0 ? multiMachine.models : [undefined];
  const capacities = multiMachine.capacities.length > 0 ? multiMachine.capacities : [undefined];

  const variants: MultiMachineVariant[] = [];
  for (const model of models) {
    // Model variants (e.g. Miner Mk.1/2/3) each have their own `Machines`
    // entry with their own AveragePower/Cost/etc. Families with no model
    // list (Oil Extractor, Resource Well Extractor, Geothermal Generator,
    // Space Elevator) share one `Machines` entry keyed by the family name.
    const machine = requireMachine(gameData, model?.name ?? multiMachine.name);
    for (const capacity of capacities) {
      const ratio = multiply(model?.partsRatio ?? ONE, capacityRatio(capacity));
      variants.push({
        multiMachineName: multiMachine.name,
        model,
        capacity,
        machine,
        ratio,
        ratioKind: multiMachine.ratioKind,
        isDefaultModel: model?.isDefault ?? true,
        isDefaultCapacity: capacity?.isDefault ?? true,
      });
    }
  }
  return variants;
}

/**
 * Resolves a `Recipe.Machine` string (or any machine/MultiMachine family
 * name) against the union of `Machines` and `MultiMachines`. Returns a
 * discriminated union: `{ kind: "machine" }` for a plain lookup, or
 * `{ kind: "multiMachine" }` carrying the full model × capacity variant
 * crossing for the five special-cased names.
 *
 * Throws if `name` isn't found in either table.
 */
export function resolveMachine(name: string, gameData: GameData): ResolvedMachine {
  if (MULTI_MACHINE_RECIPE_NAMES.has(name)) {
    const multiMachine = gameData.multiMachinesByName.get(name);
    if (!multiMachine) {
      throw new Error(
        `"${name}" is a MultiMachine-resolved name but no MultiMachine entry was found for it`,
      );
    }
    return {
      kind: "multiMachine",
      name,
      multiMachine,
      variants: buildVariants(gameData, multiMachine),
    };
  }

  return { kind: "machine", machine: requireMachine(gameData, name) };
}

/** Finds one variant of a resolved MultiMachine by model and/or capacity name. */
export function findVariant(
  resolved: ResolvedMultiMachine,
  options: { model?: string; capacity?: string } = {},
): MultiMachineVariant | undefined {
  return resolved.variants.find(
    (v) =>
      (options.model === undefined || v.model?.name === options.model) &&
      (options.capacity === undefined || v.capacity?.name === options.capacity),
  );
}

/** The variant with `Default: true` model and capacity (falling back to the first when unmarked). */
export function defaultVariant(resolved: ResolvedMultiMachine): MultiMachineVariant | undefined {
  return (
    resolved.variants.find((v) => v.isDefaultModel && v.isDefaultCapacity) ?? resolved.variants[0]
  );
}

/**
 * A recipe's inherent per-minute rate for one of its parts, before any
 * MultiMachine model/capacity multiplier: `(amount / batchTime) × 60`.
 * Signed, matching `RecipePart.amount` (negative = consumption rate).
 *
 * Throws if `part` isn't one of the recipe's parts.
 */
export function baseRecipeRatePerMinute(recipe: Recipe, part: string): Rational {
  const entry = recipe.parts.find((p) => p.part === part);
  if (!entry) {
    throw new Error(`Recipe "${recipe.name}" has no part "${part}"`);
  }
  return multiply(divide(entry.amount, recipe.batchTime), of(60));
}

/**
 * A recipe's per-minute rate for one of its parts when run through a
 * specific resolved MultiMachine variant: the base rate scaled by the
 * variant's combined model × capacity ratio.
 *
 * This is the function the golden-value test uses to verify PLAN.md §1's
 * "Miner Mk.3 on Pure = 480/min": `baseRecipeRatePerMinute` gives `1`
 * (Amount `1` / BatchTime `60` × 60) for the "Iron Ore" recipe, and the Mk.3
 * × Pure variant's `ratio` is `240 × 2 = 480`, so this returns `480`.
 */
export function multiMachineRecipeRatePerMinute(
  recipe: Recipe,
  part: string,
  variant: MultiMachineVariant,
): Rational {
  return multiply(baseRecipeRatePerMinute(recipe, part), variant.ratio);
}
