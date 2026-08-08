// Which recipe `planFactory.ts` picks per required part, when the user wants
// something other than the default "cheapest by production-step depth"
// ordering (`sortRecipesForChooser`, `recipeChooser/filters.ts`). Each
// non-"balanced" priority defines a per-unit-of-output WEIGHT — machines
// needed, raw resources drawn, total node count, or power drawn — and picks
// whichever candidate recipe minimizes it, recursively through its own
// inputs' best achievable weight.
//
// This mirrors `filters.ts`'s own `computeRecipeCostDepths` (iterative
// relaxation over the WHOLE recipe graph until a fixed point, since the real
// graph has cycles — Converter ore loops — that a naive recursive walk would
// infinite-loop on) but generalizes it to a pluggable weight function and
// tracks which recipe actually achieves each part's best weight, not just
// the weight itself.
//
// Every weight here is a plain `number` (not an exact `Rational`) —
// deliberately: this is a RANKING heuristic that decides which recipe gets
// used, not a value that ends up displayed or stored. `planFactory.ts`'s own
// Phase 2 demand propagation is what computes the real, exact machine counts
// afterward, using whichever recipe this module picked.
import {
  type GameData,
  type Machine,
  type Recipe,
} from "@scm/gamedata";
import { isNegative, isPositive, toApproximateNumber } from "@scm/rational";

import { buildNodeInputForRecipe, sortRecipesForChooser } from "../../panels/recipeChooser/filters";
import { ratePerMachineAtFullClock, type MachineRef } from "../nodes";

export const GENERATION_PRIORITIES = [
  "balanced",
  "fewestMachines",
  "fewestRawResources",
  "simplestChain",
  "lowestPower",
] as const;

export type GenerationPriority = (typeof GENERATION_PRIORITIES)[number];

export interface GenerationPriorityOption {
  value: GenerationPriority;
  labelKey: string;
  descriptionKey: string;
}

/** UI-facing metadata for the dialog's priority selector, in display order. */
export const GENERATION_PRIORITY_OPTIONS: readonly GenerationPriorityOption[] = [
  {
    value: "balanced",
    labelKey: "canvas.generateFactoryPriorityBalanced",
    descriptionKey: "canvas.generateFactoryPriorityBalancedDesc",
  },
  {
    value: "fewestMachines",
    labelKey: "canvas.generateFactoryPriorityFewestMachines",
    descriptionKey: "canvas.generateFactoryPriorityFewestMachinesDesc",
  },
  {
    value: "fewestRawResources",
    labelKey: "canvas.generateFactoryPriorityFewestRawResources",
    descriptionKey: "canvas.generateFactoryPriorityFewestRawResourcesDesc",
  },
  {
    value: "simplestChain",
    labelKey: "canvas.generateFactoryPrioritySimplestChain",
    descriptionKey: "canvas.generateFactoryPrioritySimplestChainDesc",
  },
  {
    value: "lowestPower",
    labelKey: "canvas.generateFactoryPriorityLowestPower",
    descriptionKey: "canvas.generateFactoryPriorityLowestPowerDesc",
  },
];

export interface RecipeSelector {
  /**
   * Every one of `candidates`, best-first, under this selector's priority.
   * `planFactory.ts`'s discovery walk needs the FULL ranking (not just the
   * winner) so it can fall through to the next-best candidate when the top
   * choice would close a cycle back to a part still being resolved — see
   * that module's header for why a purely weight-based "just take the
   * minimum" pick isn't safe on its own (unlike `"balanced"`'s cost-depth
   * ordering, a rate-weighted minimum has no guarantee against a mutually
   * self-referential pair like Recycled Plastic/Recycled Rubber).
   */
  rank(part: string, candidates: readonly Recipe[]): Recipe[];
  /** `rank(...)[0]` — convenience for callers that only want the top choice and don't need cycle-avoidance (e.g. tests). `undefined` only if `candidates` is empty. */
  pick(part: string, candidates: readonly Recipe[]): Recipe | undefined;
}

// ---------------------------------------------------------------------------
// Precomputed per-recipe facts — resolved machine/purity and per-machine
// rates for every part, at 100% clock/0 shards (same baseline
// `planFactory.ts`'s own discovery loop uses). Computed once per
// `createRecipeSelector` call, shared across every weight-function
// evaluation during relaxation, rather than re-resolved on every iteration.
// ---------------------------------------------------------------------------

interface RecipeFacts {
  recipe: Recipe;
  machine?: Machine;
  /** Positive-amount parts, per-machine rate at 100% clock (unsigned). */
  outputs: readonly { part: string; rate: number }[];
  /** Negative-amount parts, per-machine rate at 100% clock (unsigned, i.e. consumption magnitude). */
  inputs: readonly { part: string; rate: number }[];
}

function precomputeRecipeFacts(gameData: GameData, disabledRecipes: ReadonlySet<string>): RecipeFacts[] {
  const facts: RecipeFacts[] = [];
  for (const recipe of gameData.recipes) {
    // Generators (PLAN.md's "no positive parts" definition) never appear as
    // a `recipesByPartAsOutput` candidate for any part, so they'd never be
    // picked anyway — skipped here purely to avoid resolving a machine ref
    // for something that can never contribute a weight.
    if (recipe.isGenerator || disabledRecipes.has(recipe.name)) continue;

    let ref: MachineRef;
    try {
      const built = buildNodeInputForRecipe({ gameData, recipe, containerId: "", position: { x: 0, y: 0 } });
      ref = { machine: built.machine, purity: built.purity };
    } catch {
      continue; // defensive — a recipe whose machine family can't resolve at all just contributes no weight
    }

    const outputs: { part: string; rate: number }[] = [];
    const inputs: { part: string; rate: number }[] = [];
    for (const p of recipe.parts) {
      const rate = Math.abs(toApproximateNumber(ratePerMachineAtFullClock(gameData, recipe, ref, p.part)));
      if (isNegative(p.amount)) inputs.push({ part: p.part, rate });
      else if (isPositive(p.amount)) outputs.push({ part: p.part, rate });
    }
    // `ref.machine` is always non-null here — see the matching comment in `planFactory.ts`.
    facts.push({ recipe, machine: gameData.machinesByName.get(ref.machine!), outputs, inputs });
  }
  return facts;
}

/**
 * Computes one recipe's weight for producing `ownRate` units/min of one of
 * its own output parts, given `inputWeight` (the best already-known weight
 * for each of its input parts — `undefined` if that input's weight hasn't
 * been resolved by relaxation yet, in which case this recipe's own weight
 * can't be computed this round either).
 */
type WeightFn = (facts: RecipeFacts, ownRate: number, inputWeight: (part: string) => number | undefined) => number | undefined;

/** Sum of `(input's per-unit-output consumption) × (that input's own best weight)`, recursively — the shared shape every weight function below builds on, differing only in what the RECIPE ITSELF contributes on top. */
function sumWeightedInputs(facts: RecipeFacts, ownRate: number, inputWeight: (part: string) => number | undefined): number | undefined {
  let total = 0;
  for (const { part, rate } of facts.inputs) {
    const weight = inputWeight(part);
    if (weight === undefined) return undefined;
    total += (rate / ownRate) * weight;
  }
  return total;
}

const WEIGHT_FUNCTIONS: Record<Exclude<GenerationPriority, "balanced">, WeightFn> = {
  // Machines needed per unit/min of output: this recipe's own machine
  // density (1/ownRate) plus each input's own machine weight, scaled by how
  // much of that input one unit/min of output actually needs.
  fewestMachines: (facts, ownRate, inputWeight) => {
    const inputTotal = sumWeightedInputs(facts, ownRate, inputWeight);
    return inputTotal === undefined ? undefined : 1 / ownRate + inputTotal;
  },

  // Total raw-material extraction rate per unit/min of output, treating
  // every raw resource as an interchangeable "1 unit" (the game's raw
  // extraction recipes — Miner/Water Extractor/etc. — have no inputs, so
  // they're this recursion's base case: producing 1 unit/min of a raw part
  // IS 1 unit/min of raw extraction, by definition).
  fewestRawResources: (facts, ownRate, inputWeight) => {
    if (facts.inputs.length === 0) return 1;
    return sumWeightedInputs(facts, ownRate, inputWeight);
  },

  // Total node count of the production subtree, UNweighted by throughput —
  // this recipe itself (1) plus every input's own subtree size. Sums rather
  // than takes the max (unlike `sortRecipesForChooser`'s cost-depth, which
  // is the longest chain): a recipe with 3 different inputs, each needing
  // their own sub-chain, has more total connections than one needing a
  // single, equally-deep input — depth alone misses that "hub" complexity.
  simplestChain: (facts, _ownRate, inputWeight) => {
    let total = 1;
    for (const { part } of facts.inputs) {
      const weight = inputWeight(part);
      if (weight === undefined) return undefined;
      total += weight;
    }
    return total;
  },

  // Total power (MW) drawn per unit/min of output. `averagePower`'s sign
  // convention (PLAN.md §1) is positive = generates, negative = consumes —
  // every candidate here is a real consumer (generators are filtered out in
  // `precomputeRecipeFacts`), so `Math.abs` turns "consumes 55 MW" into a
  // positive cost to minimize rather than a negative one relaxation would
  // never treat as "worse."
  lowestPower: (facts, ownRate, inputWeight) => {
    const effectivePower = facts.recipe.averagePower ?? facts.machine?.averagePower;
    const ownPower = effectivePower ? Math.abs(toApproximateNumber(effectivePower)) / ownRate : 0;
    const inputTotal = sumWeightedInputs(facts, ownRate, inputWeight);
    return inputTotal === undefined ? undefined : ownPower + inputTotal;
  },
};

/**
 * Iterative relaxation (Bellman-Ford-style — every weight/rate here is
 * non-negative, so there are no negative cycles and this is guaranteed to
 * converge, same termination argument as `filters.ts`'s
 * `computeRecipeCostDepths`) over every precomputed recipe until no part's
 * best ACHIEVABLE weight improves further. Returns just the converged
 * per-part weight — not which recipe achieved it, since `createRecipeSelector`
 * below needs to rank EVERY candidate for a part (to support falling through
 * past a cycle-forming one), not just remember the single winner.
 *
 * Convergence gives the true minimum achievable weight per part, but does
 * NOT mean the recipe that achieves it for one part is free of a mutual
 * dependency with another — e.g. Recycled Plastic and Recycled Rubber (each
 * converts the other + Fuel back into itself) can BOTH legitimately look
 * like the cheapest option for their respective part once the other's
 * weight is known, even though picking both simultaneously would form a
 * cycle no topological demand pass could ever finish. Breaking that tie
 * safely is `planFactory.ts`'s job (it has the ancestor-tracking context to
 * do so), which is exactly why this module exposes a full ranking instead
 * of quietly resolving to one "answer" here.
 */
function relaxPartWeights(facts: readonly RecipeFacts[], weightFn: WeightFn): Map<string, number> {
  const weight = new Map<string, number>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const info of facts) {
      for (const { part, rate } of info.outputs) {
        const candidateWeight = weightFn(info, rate, (p) => weight.get(p));
        if (candidateWeight === undefined) continue;
        const current = weight.get(part);
        if (current === undefined || candidateWeight < current) {
          weight.set(part, candidateWeight);
          changed = true;
        }
      }
    }
  }
  return weight;
}

/**
 * Builds a `RecipeSelector` for `priority`. `"balanced"` is a thin wrapper
 * over the existing `sortRecipesForChooser` ordering (no relaxation needed —
 * it's already a pure per-candidate-list comparator); every other priority
 * runs the full-game-data relaxation once up front, then ranks any given
 * candidate list by evaluating each candidate's OWN weight against the
 * final converged per-part weights (valid for ranking purposes even for a
 * losing candidate, since every input weight it reads is already the true
 * achievable minimum).
 */
export function createRecipeSelector(
  gameData: GameData,
  priority: GenerationPriority,
  disabledRecipes: ReadonlySet<string>,
): RecipeSelector {
  if (priority === "balanced") {
    return {
      rank: (_part, candidates) => sortRecipesForChooser(gameData, candidates),
      pick: (_part, candidates) => sortRecipesForChooser(gameData, candidates)[0],
    };
  }

  const facts = precomputeRecipeFacts(gameData, disabledRecipes);
  const factsByRecipeName = new Map(facts.map((info) => [info.recipe.name, info]));
  const weightFn = WEIGHT_FUNCTIONS[priority];
  const partWeight = relaxPartWeights(facts, weightFn);

  function rank(part: string, candidates: readonly Recipe[]): Recipe[] {
    const scored = candidates.map((recipe, index) => {
      const info = factsByRecipeName.get(recipe.name);
      const ownRate = info?.outputs.find((o) => o.part === part)?.rate;
      const weight =
        info && ownRate !== undefined ? weightFn(info, ownRate, (p) => partWeight.get(p)) : undefined;
      // `index` (original candidate order) is the tiebreak for anything
      // this priority's own weight function can't score at all — e.g. a
      // recipe disabled mid-relaxation-precompute, or a genuinely
      // unresolvable one — so those still sort deterministically last
      // rather than colliding at the same `Infinity`.
      return { recipe, weight: weight ?? Number.POSITIVE_INFINITY, index };
    });
    scored.sort((a, b) => a.weight - b.weight || a.index - b.index);
    return scored.map((entry) => entry.recipe);
  }

  return { rank, pick: (part, candidates) => rank(part, candidates)[0] };
}
