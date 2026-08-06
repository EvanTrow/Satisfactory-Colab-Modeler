// Pure filtering + node-input-building logic for the Recipe Chooser
// (Job 009). Deliberately free of React/DOM so it's unit-testable with
// vitest without any component/browser setup — see `filters.test.ts`.
// `RecipeChooser.tsx` is a thin UI shell around these functions.
import {
  compareTiers,
  defaultVariant,
  findVariant,
  resolveMachine,
  type GameData,
  type Recipe,
  type Tier,
} from "@scm/gamedata";
import type { NewNodeInput, Purity } from "@scm/ydoc";

import { defaultLimitMode } from "../../canvas/nodes/recipeNodeMath";

/** PLAN.md §3's four composable Recipe Chooser filters. */
export interface RecipeChooserFilters {
  /** Case-insensitive substring match against the recipe's name. Empty string = no text filter. */
  search: string;
  /** Exact match against `Recipe.machine` (the raw, pre-resolution name, e.g. `"Assembler"` or `"Miner"`). `null` = any machine. */
  machine: string | null;
  /** Exact match against `Tier.raw` (e.g. `"6-1"`). `null` = any tier. */
  tier: string | null;
  /** When true, only recipes with `alternate: true` are kept. */
  alternatesOnly: boolean;
}

export const EMPTY_RECIPE_FILTERS: RecipeChooserFilters = {
  search: "",
  machine: null,
  tier: null,
  alternatesOnly: false,
};

/**
 * Every machine name at least one recipe actually uses — the left pane's
 * list, and the option set for the "machine" filter. Deliberately built
 * from `recipesByMachine` (24 names in the real dataset) rather than
 * `gameData.machines` (32 entries): the latter includes machines no recipe
 * ever references directly (e.g. individual `Miner Mk.1/2/3` model
 * entries, `Storage Container`, `Fluid Buffer`) which would be dead
 * filter options here.
 */
export function listChooserMachines(gameData: GameData): string[] {
  return Array.from(gameData.recipesByMachine.keys()).sort((a, b) => a.localeCompare(b));
}

/** Every tier that appears on at least one recipe, deduplicated and sorted low to high. */
export function listChooserTiers(gameData: GameData): Tier[] {
  const seen = new Map<string, Tier>();
  for (const recipe of gameData.recipes) {
    if (!seen.has(recipe.tier.raw)) {
      seen.set(recipe.tier.raw, recipe.tier);
    }
  }
  return Array.from(seen.values()).sort(compareTiers);
}

/**
 * Applies all four filters as an AND-composition (matching PLAN.md §3's
 * "text + tier + alternate-only simultaneously" example), sorted by tier
 * then name for a stable, readable list.
 */
export function filterRecipes(gameData: GameData, filters: RecipeChooserFilters): Recipe[] {
  const search = filters.search.trim().toLowerCase();
  return gameData.recipes
    .filter((recipe) => {
      if (search && !recipe.name.toLowerCase().includes(search)) return false;
      if (filters.machine && recipe.machine !== filters.machine) return false;
      if (filters.tier && recipe.tier.raw !== filters.tier) return false;
      if (filters.alternatesOnly && !recipe.alternate) return false;
      return true;
    })
    .sort((a, b) => compareTiers(a.tier, b.tier) || a.name.localeCompare(b.name));
}

/** A user's choice of MultiMachine model/capacity (e.g. `{ model: "Miner Mk.3", capacity: "Pure" }`). Either field may be omitted to fall back to that dimension's default. */
export interface RecipeVariantChoice {
  model?: string;
  capacity?: string;
}

/**
 * Maps a MultiMachine capacity name onto `NodeRecord.purity`'s closed enum.
 * Only Miner/Oil Extractor/Resource Well Extractor/Geothermal Generator use
 * the Impure/Normal/Pure naming (the only capacity-bearing families a
 * `Recipe.machine` ever actually resolves to — `AWESOME Sink` and
 * `Dimensional Depot Uploader` are MultiMachines too, per `@scm/gamedata`,
 * but no recipe's `machine` field is ever one of those two names). Any
 * other capacity naming (there is none among recipe-reachable machines
 * today, but the mapping is total for safety) yields `null` rather than
 * throwing.
 */
function capacityToPurity(capacityName: string | undefined): Purity | null {
  switch (capacityName) {
    case "Impure":
      return "impure";
    case "Normal":
      return "normal";
    case "Pure":
      return "pure";
    default:
      return null;
  }
}

export interface BuildNodeInputParams {
  gameData: GameData;
  recipe: Recipe;
  containerId: string;
  position: { x: number; y: number };
  /**
   * Only consulted when `recipe.machine` resolves to a MultiMachine;
   * ignored for plain machines. Any field left unset (or the whole object
   * omitted) falls back to `defaultVariant`'s pick for that dimension —
   * deliberately NOT implemented by passing a half-empty options object to
   * `findVariant` (its `undefined` fields match *any* value, which for
   * MultiMachines whose default isn't first in variant-crossing order,
   * e.g. Miner's default is Mk.1×Normal but variants are built
   * model-major/capacity-minor so Mk.1×Impure comes first, would silently
   * resolve to the wrong variant).
   */
  variantChoice?: RecipeVariantChoice;
}

/**
 * Resolves `recipe.machine` (via `@scm/gamedata`'s `resolveMachine`) and
 * builds the `NewNodeInput` `addNode` needs.
 *
 * - Plain machine: `machine` is the recipe's own machine name verbatim
 *   (e.g. `"Assembler"`), `purity` is `null`.
 * - MultiMachine-backed recipe (Miner, Oil Extractor, Resource Well
 *   Extractor, Geothermal Generator, Space Elevator): `machine` becomes the
 *   *resolved concrete* machine name for the chosen variant (e.g.
 *   `"Miner Mk.3"`, or the family name itself for MultiMachines with no
 *   model list, e.g. `"Geothermal Generator"`/`"Space Elevator"`), and
 *   `purity` captures the chosen capacity when it maps to
 *   Impure/Normal/Pure. This is the only place a chosen model survives
 *   onto the node record — `NodeRecord` (packages/ydoc/src/schema.ts) has
 *   no separate "model" field, so Job 010 (and anything else reading these
 *   nodes back) must recover the model choice from `machine` itself rather
 *   than expecting a dedicated field.
 *
 * `limitMode` is set via Job 010's `defaultLimitMode` (ppm for Miner/AWESOME
 * Sink, machine count otherwise, per PLAN.md §2's "Set a limit" row) —
 * Job 009 originally hardcoded `"machines"` here for every node; that
 * defaulting rule was explicitly deferred to Job 010, the first job that
 * actually needed it.
 */
export function buildNodeInputForRecipe(params: BuildNodeInputParams): NewNodeInput {
  const { gameData, recipe, containerId, position, variantChoice } = params;
  const resolved = resolveMachine(recipe.machine, gameData);

  let machineName: string;
  let purity: Purity | null = null;

  if (resolved.kind === "machine") {
    machineName = resolved.machine.name;
  } else {
    const requested = variantChoice ? findVariant(resolved, variantChoice) : undefined;
    const variant = requested ?? defaultVariant(resolved);
    if (!variant) {
      throw new Error(`buildNodeInputForRecipe: MultiMachine "${resolved.name}" has no variants`);
    }
    machineName = variant.machine.name;
    purity = capacityToPurity(variant.capacity?.name);
  }

  return {
    containerId,
    kind: "recipe",
    recipe: recipe.name,
    machine: machineName,
    x: position.x,
    y: position.y,
    title: recipe.name,
    color: "#4b5563",
    limit: null,
    limitMode: defaultLimitMode(recipe.machine),
    clock: null,
    autoRound: false,
    shards: 0,
    purity,
    beltTier: null,
    storageMode: null,
  };
}
