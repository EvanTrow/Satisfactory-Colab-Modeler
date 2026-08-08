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
  type RecipePart,
  type Tier,
} from "@scm/gamedata";
import { abs, compare, isNegative } from "@scm/rational";
import type { NewNodeInput, Purity } from "@scm/ydoc";

import { defaultLimitMode, partHandleId } from "../../canvas/nodes/recipeNodeMath";
// Leaf import (not the `../../canvas/edges` barrel) — that barrel also
// re-exports `ConnectionEdge`/`useConnectionHandlers` (React Flow, DOM), and
// this module is deliberately kept React/DOM-free (see this file's header)
// so it stays unit-testable with plain vitest.
import { isWildcardPart } from "../../canvas/edges/connectionLogic";
import { maxTierForPhase } from "./progression";

/**
 * The Recipe Chooser's search box can match against three different fields
 * of a recipe at once — its own name, and the names of its input/output
 * parts (Steam-app-inspired, per this feature's own request: "Search should
 * filter by recipe name, inputs & outputs" with a switch to enable/disable
 * each independently). Each is a standalone OR-branch of the same search
 * text, not a separate text field — turning every switch off means the
 * search text matches nothing (there's nothing left to search), which is
 * `filterRecipes`'s literal, predictable reading of "search this field" set
 * to false for all three.
 */
export interface RecipeChooserFilters {
  /** Case-insensitive substring match, applied to whichever of `searchByName`/`searchByInputs`/`searchByOutputs` are enabled. Empty string = no text filter regardless of switches. */
  search: string;
  searchByName: boolean;
  searchByInputs: boolean;
  searchByOutputs: boolean;
  /** Exact match against `Recipe.machine` (the raw, pre-resolution name, e.g. `"Assembler"` or `"Miner"`). `null` = any machine. */
  machine: string | null;
  /** Exact match against `Tier.raw` (e.g. `"6-1"`). `null` = any tier. */
  tier: string | null;
  /** When true, only recipes with `alternate: true` are kept. */
  alternatesOnly: boolean;
}

export const EMPTY_RECIPE_FILTERS: RecipeChooserFilters = {
  search: "",
  searchByName: true,
  searchByInputs: true,
  searchByOutputs: true,
  machine: null,
  tier: null,
  alternatesOnly: false,
};

/**
 * The project-wide progression gate (`Settings.recipeTierFilter`/
 * `recipePhaseFilter`) — unlike `RecipeChooserFilters.tier`'s per-open exact
 * match, both fields here are cumulative ("show what's available by this
 * point") and AND together with everything else when set. `tier` compares
 * against `Tier.tier` directly (the major 0-9 number, ignoring milestone);
 * `phase` resolves to a Tier cap via `progression.ts`'s `maxTierForPhase`
 * (the game's real Space Elevator delivery-unlock table — see that module's
 * header for why this can't be derived from `game_data.json`). `null`
 * disables that axis entirely. `SettingsMenu.tsx` also uses
 * `progression.ts`'s `isValidProgressionSelection` to keep the two fields
 * from ever being set to a combination that couldn't occur in a real save,
 * so in practice `tier` and `phase` never actively contradict each other
 * here — but this function doesn't assume that: it just takes the stricter
 * (lower) of whichever caps are set.
 */
export interface RecipeProgressionFilter {
  tier: number | null;
  phase: number | null;
}

export const NO_PROGRESSION_FILTER: RecipeProgressionFilter = { tier: null, phase: null };

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

function partMatches(parts: readonly RecipePart[], direction: "in" | "out", search: string): boolean {
  return parts.some(
    (p) => (isNegative(p.amount) ? "in" : "out") === direction && p.part.toLowerCase().includes(search),
  );
}

/** Whether `recipe` matches `search` under the three name/inputs/outputs switches — an OR across whichever switches are on, per `RecipeChooserFilters`'s own doc comment. Always `true` for an empty search. */
function recipeMatchesSearch(recipe: Recipe, filters: RecipeChooserFilters, search: string): boolean {
  if (!search) return true;
  if (filters.searchByName && recipe.name.toLowerCase().includes(search)) return true;
  if (filters.searchByInputs && partMatches(recipe.parts, "in", search)) return true;
  if (filters.searchByOutputs && partMatches(recipe.parts, "out", search)) return true;
  return false;
}

/** The stricter (lower) of `progression`'s two Tier caps — 9 (no-op) when neither axis is set. */
function progressionMaxTier(progression: RecipeProgressionFilter): number {
  return Math.min(progression.tier ?? 9, maxTierForPhase(progression.phase));
}

/**
 * Hand-authored approximate machine unlock order (the redesign's own
 * "order by when a machine is unlocked in the game" sort key). Satisfactory's
 * real HUB/MAM/AWESOME-shop unlock order isn't data `@scm/gamedata` carries
 * anywhere (only each RECIPE's own `Tier` is, via `game_data.json`) — this is
 * a manually-curated ordering of every machine name `listChooserMachines`
 * can return, used purely as a same-tier tiebreaker in
 * `sortRecipesForChooser`, roughly matching real early-to-late unlock order
 * (extractors and Tier-0 processing first, endgame Quantum
 * Encoder/Converter/FICSMAS last). A machine missing from this list
 * (shouldn't happen — kept in sync with `listChooserMachines`'s own 24-name
 * output) sorts after every listed one, via `machineUnlockRank`'s fallback.
 */
const MACHINE_UNLOCK_ORDER: readonly string[] = [
  "Miner",
  "Water Extractor",
  "Smelter",
  "Constructor",
  "Biomass Burner",
  "Assembler",
  "Foundry",
  "Coal-Powered Generator",
  "Oil Extractor",
  "Refinery",
  "Packager",
  "Manufacturer",
  "Blender",
  "Fuel-Powered Generator",
  "Particle Accelerator",
  "Resource Well Pressurizer",
  "Resource Well Extractor",
  "Nuclear Power Plant",
  "Converter",
  "Quantum Encoder",
  "Geothermal Generator",
  "Alien Power Augmenter",
  "Space Elevator",
  "FICSMAS Gift Tree",
];

/** `MACHINE_UNLOCK_ORDER`'s index for `machine`, or the list's length (sorts last) if it's somehow missing. */
function machineUnlockRank(machine: string): number {
  const index = MACHINE_UNLOCK_ORDER.indexOf(machine);
  return index === -1 ? MACHINE_UNLOCK_ORDER.length : index;
}

/** Sentinel for a recipe `computeRecipeCostDepths` never reached a fixed point for (shouldn't happen on real `game_data.json` — every part has SOME producing recipe — but keeps the comparator total instead of throwing on a future data change). Sorts after every resolved depth. */
const UNRESOLVED_COST_DEPTH = Number.MAX_SAFE_INTEGER;

/**
 * "Recipe cost" (the redesign's own term for its first sort key: "order by
 * recipe cost meaning ore is 0 and ingot using a smelter [is 1]") — how many
 * production steps deep a recipe sits. A recipe with no input parts (Miner/
 * Water Extractor/other raw extraction, or a genuinely power-only recipe)
 * is depth 0; a recipe consuming only depth-0 parts (e.g. Smelter's Iron
 * Ingot, consuming Miner's Iron Ore) is depth 1; and so on. A part's own
 * cost is the CHEAPEST depth among every recipe that produces it (including
 * alternates — this is "the best way to get this part," not "the standard
 * way"), and a recipe's cost is 1 + the MOST expensive of its own inputs
 * (its bottleneck ingredient).
 *
 * Computed via iterative relaxation (a standard shortest-path fixed point,
 * bounded above by the number of distinct recipes so it always terminates)
 * rather than a single recursive pass, specifically because the real recipe
 * graph has CYCLES (Converter recipes convert ores back and forth, e.g.
 * "Iron Ore (Limestone)" and "Limestone (Sulfur)" chain toward recipes that
 * eventually feed back into Iron Ore) — a naive recursive depth-first walk
 * would infinite-loop on those. Relaxation is cycle-safe for free: a cycle
 * can never improve on the best acyclic path already found, so it simply
 * stops contributing once every acyclic route has been discovered.
 */
function computeRecipeCostDepths(gameData: GameData): Map<string, number> {
  const partCost = new Map<string, number>();
  const recipeCost = new Map<string, number>();
  for (const recipe of gameData.recipes) recipeCost.set(recipe.name, UNRESOLVED_COST_DEPTH);

  let changed = true;
  while (changed) {
    changed = false;
    for (const recipe of gameData.recipes) {
      const inputs = recipe.parts.filter((p) => isNegative(p.amount));
      let cost = 0;
      for (const input of inputs) {
        const inputCost = partCost.get(input.part);
        if (inputCost === undefined) {
          cost = UNRESOLVED_COST_DEPTH;
          break;
        }
        cost = Math.max(cost, inputCost);
      }
      if (cost !== UNRESOLVED_COST_DEPTH && inputs.length > 0) cost += 1;

      if (cost < recipeCost.get(recipe.name)!) {
        recipeCost.set(recipe.name, cost);
        changed = true;
        for (const output of recipe.parts.filter((p) => !isNegative(p.amount))) {
          const prevPartCost = partCost.get(output.part);
          if (prevPartCost === undefined || cost < prevPartCost) {
            partCost.set(output.part, cost);
          }
        }
      }
    }
  }
  return recipeCost;
}

/** Per-`GameData` memoization for `computeRecipeCostDepths` — the whole-graph relaxation only needs to run once for the app's single `defaultGameData` instance, not on every keystroke's `filterRecipes` call. */
const costDepthCache = new WeakMap<GameData, Map<string, number>>();
function getRecipeCostDepths(gameData: GameData): Map<string, number> {
  let cached = costDepthCache.get(gameData);
  if (!cached) {
    cached = computeRecipeCostDepths(gameData);
    costDepthCache.set(gameData, cached);
  }
  return cached;
}

/**
 * The redesign's own hardcoded sort order, applied on top of whatever
 * filters already narrowed the list to. In priority order (each key only
 * breaks ties left by the one before it):
 *
 * 1. Seasonal (`Recipe.ficsmas`) last — the OUTERMOST key, ahead of even
 *    cost. This produces exactly two back-to-back groups: every normal
 *    recipe first (internally ordered by keys 2-6 below), then every
 *    FICSMAS recipe after (ALSO internally ordered by keys 2-6, among
 *    themselves) — not seasonal items scattered throughout, demoted only
 *    within whatever cost/tier bucket they'd otherwise land in.
 * 2. Recipe cost (`computeRecipeCostDepths`) — cheaper/shallower first.
 * 3. Standard before alternate.
 * 4. Tier (`compareTiers`, tier then milestone) — lower first. A "Tier and
 *    phase" key was requested, but Space Elevator phase isn't a per-recipe
 *    attribute anywhere in this app's data (`progression.ts`'s `phase` is a
 *    project-wide delivery-unlock GATE, not something an individual recipe
 *    carries — see that module's header) — every Space Elevator phase
 *    recipe's own `Tier` already increases in step with its phase number
 *    (Phase 1 is Tier 2-1, Phase 5 is Tier 9-4, etc.), so sorting by Tier
 *    alone already produces phase order for free. No separate phase key.
 * 5. Machine unlock order (`machineUnlockRank`, hand-authored — see its own
 *    doc comment).
 * 6. Name, alphabetical — final stable tiebreaker so the list never
 *    reorders itself between renders for reasons a user can't see.
 *
 * A requested key ("sort alternate unlock ability based on tier and phase")
 * was dropped as redundant: an alternate's own unlock tier/phase is exactly
 * the same `recipe.tier` field key 4 above already sorts every recipe
 * (standard or alternate) by — there's no separate "alternate unlock tier"
 * data to sort by beyond that.
 */
export function sortRecipesForChooser(gameData: GameData, recipes: readonly Recipe[]): Recipe[] {
  const costDepths = getRecipeCostDepths(gameData);
  return [...recipes].sort((a, b) => {
    if (a.ficsmas !== b.ficsmas) return a.ficsmas ? 1 : -1;
    const costCompare = (costDepths.get(a.name) ?? UNRESOLVED_COST_DEPTH) - (costDepths.get(b.name) ?? UNRESOLVED_COST_DEPTH);
    if (costCompare !== 0) return costCompare;
    if (a.alternate !== b.alternate) return a.alternate ? 1 : -1;
    const tierCompare = compareTiers(a.tier, b.tier);
    if (tierCompare !== 0) return tierCompare;
    const machineCompare = machineUnlockRank(a.machine) - machineUnlockRank(b.machine);
    if (machineCompare !== 0) return machineCompare;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Applies all filters as an AND-composition (matching PLAN.md §3's
 * "text + tier + alternate-only simultaneously" example — the search text
 * itself is an OR across its three switches, see `recipeMatchesSearch`),
 * then `sortRecipesForChooser`'s hardcoded ordering. `progression` (defaults
 * to `NO_PROGRESSION_FILTER`) applies the project-wide tier/phase gate on
 * top — see `RecipeProgressionFilter`'s doc comment.
 */
export function filterRecipes(
  gameData: GameData,
  filters: RecipeChooserFilters,
  progression: RecipeProgressionFilter = NO_PROGRESSION_FILTER,
): Recipe[] {
  const search = filters.search.trim().toLowerCase();
  const maxTier = progressionMaxTier(progression);
  const matched = gameData.recipes.filter((recipe) => {
    if (!recipeMatchesSearch(recipe, filters, search)) return false;
    if (filters.machine && recipe.machine !== filters.machine) return false;
    if (filters.tier && recipe.tier.raw !== filters.tier) return false;
    if (filters.alternatesOnly && !recipe.alternate) return false;
    if (recipe.tier.tier > maxTier) return false;
    return true;
  });
  return sortRecipesForChooser(gameData, matched);
}

/**
 * A connection dragged out from a port and released on empty canvas (see
 * `CanvasView.tsx`'s `onConnectEnd` wiring) opens the Recipe Chooser
 * pre-filtered to recipes that could plug into that dangling port:
 * dragging from an OUTPUT searches for the part among recipes' INPUTS
 * (something to consume it), and dragging from an INPUT searches among
 * OUTPUTS (something to produce it) — the opposite of the port's own
 * direction, which is exactly what would make a valid connection.
 *
 * A Splurger's own ports are wildcards (`isWildcardPart` —
 * `canvas/edges/connectionLogic.ts`, true for the plain `WILDCARD_PART`
 * ("*") AND the two tiered sentinels a Priority Splitter/Merger/Splurger's
 * handles use) — they accept ANY part, so there is nothing meaningful to
 * pre-filter by. Seeding the search box with the literal sentinel string
 * (the bug this comment replaces) made `partMatches`'s substring match
 * reject essentially every real part name, so dragging from a Splurger to
 * empty canvas opened the Chooser looking broken (an apparently-empty
 * recipe list). Falls back to the unfiltered defaults instead.
 */
export function initialFiltersForPendingPart(direction: "in" | "out", part: string): RecipeChooserFilters {
  if (isWildcardPart(part)) return EMPTY_RECIPE_FILTERS;
  return {
    ...EMPTY_RECIPE_FILTERS,
    search: part,
    searchByName: false,
    searchByInputs: direction === "out",
    searchByOutputs: direction === "in",
  };
}

/**
 * The handle id (`recipeNodeMath.ts`'s `partHandleId` contract) on a node
 * that would be created from `recipe` that could satisfy a pending dragged
 * connection — `null` if `recipe` has no part in the opposite direction at
 * all (the user widened the filters and picked something with no port that
 * direction, e.g. a pure generator has no input to drag an output into).
 * Used by `RecipeChooser`'s auto-connect step right after `addNode`, once
 * the new node's real id exists.
 *
 * A pending drag from a Splurger's wildcard port (`isWildcardPart(pending
 * .part)` — the plain wildcard or either tiered sentinel) has no real part
 * name to match against — any part in the opposite direction satisfies it
 * (that's what "wildcard" means), so this takes the recipe's own primary
 * part in that direction rather than requiring an exact name match that
 * could never succeed. Everything else (a real recipe-to-recipe drag) keeps
 * the original exact-name-match rule.
 */
export function matchingHandleId(recipe: Recipe, pending: { direction: "in" | "out"; part: string }): string | null {
  const wantDirection = pending.direction === "out" ? "in" : "out";
  const candidates = recipe.parts.filter((p) => (isNegative(p.amount) ? "in" : "out") === wantDirection);
  const match = isWildcardPart(pending.part)
    // The largest-magnitude candidate in the wanted direction — the
    // recipe's own main input/output rather than an arbitrary byproduct.
    ? candidates.reduce((best, p) => (!best || compare(abs(p.amount), abs(best.amount)) > 0 ? p : best), candidates[0])
    : candidates.find((p) => p.part === pending.part);
  return match ? partHandleId(match) : null;
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
    splurgerVariant: null,
  };
}
