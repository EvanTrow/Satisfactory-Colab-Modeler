// Recipe indices (by-part, by-machine, generator flag) and tier parsing
// utilities. `buildRecipeIndices` is called once by `load.ts` per
// `loadGameData` call; `parseTier`/`compareTiers` are also used directly by
// `load.ts` to parse every `Tier` field on machines/parts/recipes.
import type { Recipe, Tier } from "./types";

const TIER_PATTERN = /^(\d+)-(\d+)$/;

/** Parses a `"tier-milestone"` string (`"0-0"` … `"9-5"`) into a comparable `Tier`. */
export function parseTier(raw: string): Tier {
  const match = TIER_PATTERN.exec(raw);
  if (!match) {
    throw new Error(`Invalid tier string: "${raw}" (expected "tier-milestone", e.g. "6-1")`);
  }
  return {
    tier: Number(match[1]),
    milestone: Number(match[2]),
    raw,
  };
}

/** Three-way compare for sorting/progression filtering: tier first, then milestone. */
export function compareTiers(a: Tier, b: Tier): -1 | 0 | 1 {
  if (a.tier !== b.tier) return a.tier < b.tier ? -1 : 1;
  if (a.milestone !== b.milestone) return a.milestone < b.milestone ? -1 : 1;
  return 0;
}

export interface RecipeIndices {
  readonly recipesByMachine: ReadonlyMap<string, readonly Recipe[]>;
  readonly recipesByPartAsInput: ReadonlyMap<string, readonly Recipe[]>;
  readonly recipesByPartAsOutput: ReadonlyMap<string, readonly Recipe[]>;
  readonly generatorRecipes: readonly Recipe[];
}

function pushInto<K>(map: Map<K, Recipe[]>, key: K, recipe: Recipe): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(recipe);
  } else {
    map.set(key, [recipe]);
  }
}

/** Builds every recipe-derived index `GameData` exposes, from an already-parsed recipe list. */
export function buildRecipeIndices(recipes: readonly Recipe[]): RecipeIndices {
  const recipesByMachine = new Map<string, Recipe[]>();
  const recipesByPartAsInput = new Map<string, Recipe[]>();
  const recipesByPartAsOutput = new Map<string, Recipe[]>();
  const generatorRecipes: Recipe[] = [];

  for (const recipe of recipes) {
    pushInto(recipesByMachine, recipe.machine, recipe);

    for (const part of recipe.parts) {
      if (part.amount.numerator < 0n) {
        pushInto(recipesByPartAsInput, part.part, recipe);
      } else if (part.amount.numerator > 0n) {
        pushInto(recipesByPartAsOutput, part.part, recipe);
      }
      // amount === 0 is neither an input nor an output; none occur in the
      // current data (every Parts entry is strictly positive or negative),
      // but a zero amount isn't malformed, so it's silently excluded from
      // both indices rather than rejected.
    }

    if (recipe.isGenerator) {
      generatorRecipes.push(recipe);
    }
  }

  return { recipesByMachine, recipesByPartAsInput, recipesByPartAsOutput, generatorRecipes };
}
