// Per-node math: resolves one `SolverNode` against `@scm/gamedata` into a
// `NodeProfile` (its recipe/machine/ratio/somersloop/power facts, all
// exact `Rational` except the two documented float boundaries), then
// exposes the handful of pure functions `manual.ts`/`basic.ts` both build
// on to turn a machine count into rates/power, or a target rate into a
// machine count.
//
// Building a profile never throws — a node with an unknown recipe, an
// unresolvable machine/variant, or an invalid shard count gets a profile
// with `issues` populated and `recipe`/`machine` left `undefined`, so one
// corrupt node can't crash the whole solve (consistent with PLAN.md §5's
// "a CRDT guarantees convergence, not correctness" framing — the solver's
// job is to report the problem, not to throw).
import {
  baseRecipeRatePerMinute,
  defaultVariant,
  resolveMachine,
  somersloopBoost,
  type GameData,
  type Machine,
  type MultiMachineVariant,
  type Recipe,
  type RecipePart,
} from "@scm/gamedata";
import {
  ONE,
  ZERO,
  abs,
  compare,
  divide,
  isPositive,
  isZero,
  multiply,
  negate,
  of,
  parseRational,
  type Rational,
} from "@scm/rational";
import { powerAtClock, toApproximateNumber } from "@scm/rational";
import type { SolverNode } from "./snapshot";

// ---------------------------------------------------------------------------
// Clock parsing/clamping — same convention `recipeNodeMath.ts` (Job 010)
// established for `@scm/ydoc`'s `NodeRecord.clock`: a percentage, hard-capped
// at 250 (PLAN.md §2), soft-floored at 1 (division-by-zero guard; the game
// itself floors underclocking at a small positive percentage). Duplicated
// here rather than imported — `apps/web` is off limits for this package.
// ---------------------------------------------------------------------------

const MIN_CLOCK_PERCENT: Rational = of(1);
const MAX_CLOCK_PERCENT: Rational = of(250);

function clampClockPercent(value: Rational): Rational {
  if (compare(value, MIN_CLOCK_PERCENT) < 0) return MIN_CLOCK_PERCENT;
  if (compare(value, MAX_CLOCK_PERCENT) > 0) return MAX_CLOCK_PERCENT;
  return value;
}

function parseClockPercent(clock: string | null): Rational {
  if (!clock) return of(100);
  try {
    return clampClockPercent(parseRational(clock));
  } catch {
    return of(100);
  }
}

// ---------------------------------------------------------------------------
// Primary-part selection — same convention as `recipeNodeMath.ts`'s
// `primaryPart`: the largest-magnitude output, or (for generators/pure
// consumers, which have no positive-amount part at all) the
// largest-magnitude input. This is the part a `limitMode: "ppm"` limit
// anchors to, and the part Basic mode's propagation prefers when a node has
// multiple candidate implied rates (see `basic.ts`).
// ---------------------------------------------------------------------------

export function primaryPart(parts: readonly RecipePart[]): RecipePart | undefined {
  if (parts.length === 0) return undefined;
  const outputs = parts.filter((p) => isPositive(p.amount));
  const pool = outputs.length > 0 ? outputs : parts;
  return pool.reduce((best, part) => (compare(abs(part.amount), abs(best.amount)) > 0 ? part : best));
}

// ---------------------------------------------------------------------------
// Machine/variant resolution.
// ---------------------------------------------------------------------------

function resolveNodeMachine(
  node: SolverNode,
  recipe: Recipe,
  gameData: GameData,
): { machine: Machine; ratio: Rational } {
  const resolved = resolveMachine(recipe.machine, gameData);
  if (resolved.kind === "machine") {
    return { machine: resolved.machine, ratio: ONE };
  }

  const matches = resolved.variants.filter((v) => v.machine.name === node.machine);
  let variant: MultiMachineVariant | undefined;
  if (matches.length <= 1) {
    variant = matches[0] ?? defaultVariant(resolved);
  } else {
    const byPurity = node.purity
      ? matches.find((v) => v.capacity?.name.toLowerCase() === node.purity)
      : undefined;
    variant = byPurity ?? matches[0];
  }
  if (!variant) {
    throw new Error(
      `node "${node.id}": could not resolve machine variant "${node.machine}" for recipe "${recipe.name}" (family "${recipe.machine}")`,
    );
  }
  return { machine: variant.machine, ratio: variant.ratio };
}

// ---------------------------------------------------------------------------
// NodeProfile.
// ---------------------------------------------------------------------------

export interface NodeProfile {
  readonly node: SolverNode;
  readonly recipe?: Recipe;
  readonly machine?: Machine;
  /** `node.clock`, parsed/clamped/defaulted. Percentage (100 = 100%). */
  readonly clockPercent: Rational;
  /** `clockPercent / 100`. */
  readonly clockFraction: Rational;
  /** Somersloop output multiplier — applies to positive-amount (output) parts only. `ONE` with 0 shards. */
  readonly outputMultiplier: Rational;
  /** Somersloop power multiplier. `ONE` with 0 shards. */
  readonly powerMultiplier: Rational;
  /** `recipe.averagePower ?? machine.averagePower` — see the module header's Converter/Particle Accelerator/Quantum Encoder note. `undefined` if neither is set. */
  readonly effectivePower?: Rational;
  /** `machine.overclockPowerExponent ?? 1` (float boundary, per `@scm/rational`'s `power.ts`). */
  readonly overclockExponent: number;
  /** `Part.name` -> signed per-minute rate for ONE machine at 100% clock, already scaled by the resolved MultiMachine ratio (but NOT by somersloop or clock — see `partRateAtMachineCount`). */
  readonly refRatePerPart: ReadonlyMap<string, Rational>;
  readonly primaryPart?: RecipePart;
  /** Non-empty only when the node's recipe/machine/shards couldn't be resolved — see the module header. */
  readonly issues: readonly string[];
  /**
   * Job 026 (Blueprints): present ONLY for a synthetic blueprint-compound
   * profile (`buildBlueprintCompoundProfile`) — signed MW at exactly 1 of
   * this node's "machine count" (i.e. 1 copy). When set, `nodePower` uses
   * this directly (`syntheticPowerAtOneUnit * machineCount`) instead of
   * the real-machine `effectivePower`/`overclockExponent`/`powerAtClock`
   * formula, since a compound node's power is already the (float) sum of
   * its whole internal subgraph's power at one copy, not a single
   * machine's overclock curve.
   */
  readonly syntheticPowerAtOneUnit?: number;
}

function emptyProfile(node: SolverNode, issues: string[], recipe?: Recipe): NodeProfile {
  return {
    node,
    recipe,
    clockPercent: parseClockPercent(node.clock),
    clockFraction: divide(parseClockPercent(node.clock), of(100)),
    outputMultiplier: ONE,
    powerMultiplier: ONE,
    overclockExponent: 1,
    refRatePerPart: new Map(),
    issues,
  };
}

// ---------------------------------------------------------------------------
// Job 026 (Blueprints): a synthetic "compound" profile for a node whose
// rates come directly from `SolverNode.blueprintCopyBasis` instead of a
// `@scm/gamedata` recipe/machine lookup. Builds a fully-valid, if synthetic,
// `Recipe` object (every field `basic.ts`/`full.ts`/`summary.ts`/
// `nodeResult.ts`/`edgeValidation.ts` might read — just `.parts`, in
// practice, since none of those modules gate on anything else) so this
// compound node behaves EXACTLY like a real recipe node to every one of
// those modules, with zero changes needed to any of them: propagation,
// even-split/water-fill sibling grouping, edge validation, node-result/
// summary building all treat it as an ordinary (if unusually-shaped) recipe.
// See jobs/026-blueprints.md's Handoff notes ("How PLAN.md §10.3 was
// resolved") for why this is the chosen mechanism.
// ---------------------------------------------------------------------------

function buildBlueprintCompoundProfile(
  node: SolverNode,
  basis: NonNullable<SolverNode["blueprintCopyBasis"]>,
): NodeProfile {
  const issues: string[] = [];
  const parts: RecipePart[] = [];
  const refRatePerPart = new Map<string, Rational>();
  for (const [part, rateString] of Object.entries(basis.perCopyRates)) {
    try {
      const amount = parseRational(rateString);
      parts.push({ part, amount });
      refRatePerPart.set(part, amount);
    } catch {
      issues.push(`blueprint compound node "${node.id}": invalid per-copy rate "${rateString}" for part "${part}"`);
    }
  }

  const recipe: Recipe = {
    name: `blueprint:${node.id}`,
    // Not a real machine family — nothing reads `Recipe.machine` for a
    // compound profile (resolution is short-circuited before
    // `resolveNodeMachine` ever runs), this just satisfies the type.
    machine: "",
    batchTime: ONE,
    tier: { tier: 0, milestone: 0, raw: "0-0" },
    parts,
    alternate: false,
    ficsmas: false,
    ignoreInputMultiplier: true,
    spaceElevatorMultiplier: false,
    isGenerator: parts.every((p) => !isPositive(p.amount)),
  };

  return {
    node,
    recipe,
    machine: undefined,
    // A compound node's "clock" is meaningless (its per-copy rates already
    // bake in whatever the internal subgraph's own clocks/shards were) —
    // fixed at 100% so `partRateAtMachineCount`/`machineCountForTargetRate`
    // (which multiply by `clockFraction`) are simple `refRate * machineCount`.
    clockPercent: of(100),
    clockFraction: ONE,
    outputMultiplier: ONE,
    powerMultiplier: ONE,
    overclockExponent: 1,
    refRatePerPart,
    primaryPart: primaryPart(parts),
    issues,
    syntheticPowerAtOneUnit: basis.perCopyPowerMW,
  };
}

/** Resolves `node` against `gameData` into a `NodeProfile`. Never throws — see the module header. */
export function buildNodeProfile(node: SolverNode, gameData: GameData): NodeProfile {
  if (node.blueprintCopyBasis) {
    return buildBlueprintCompoundProfile(node, node.blueprintCopyBasis);
  }

  const recipe = gameData.recipesByName.get(node.recipe);
  if (!recipe) {
    return emptyProfile(node, [`unknown recipe "${node.recipe}"`]);
  }

  let machine: Machine;
  let ratio: Rational;
  try {
    const resolved = resolveNodeMachine(node, recipe, gameData);
    machine = resolved.machine;
    ratio = resolved.ratio;
  } catch (err) {
    return emptyProfile(node, [(err as Error).message], recipe);
  }

  const issues: string[] = [];
  let outputMultiplier = ONE;
  let powerMultiplier = ONE;
  if (node.shards !== 0 || (machine.maxProductionShards ?? 0) > 0) {
    try {
      const boost = somersloopBoost(machine, node.shards);
      outputMultiplier = boost.outputMultiplier;
      powerMultiplier = boost.powerMultiplier;
    } catch (err) {
      issues.push((err as Error).message);
    }
  }

  const refRatePerPart = new Map(
    recipe.parts.map((p) => [p.part, multiply(baseRecipeRatePerMinute(recipe, p.part), ratio)] as const),
  );
  const clockPercent = parseClockPercent(node.clock);

  return {
    node,
    recipe,
    machine,
    clockPercent,
    clockFraction: divide(clockPercent, of(100)),
    outputMultiplier,
    powerMultiplier,
    effectivePower: recipe.averagePower ?? machine.averagePower,
    overclockExponent: machine.overclockPowerExponent ?? 1,
    refRatePerPart,
    primaryPart: primaryPart(recipe.parts),
    issues,
  };
}

// ---------------------------------------------------------------------------
// Profile -> rate/power/machine-count math. Every function below is a pure
// function of `(profile, machineCount)` or `(profile, part, targetRate)` —
// no graph awareness at all. `manual.ts` uses these directly (a node's
// entered values ARE its final values); `basic.ts` layers graph propagation
// on top to determine `machineCount` for unconstrained nodes, then calls
// the exact same functions.
// ---------------------------------------------------------------------------

/**
 * `part`'s signed per-minute rate at `machineCount` machines, this node's
 * own clock, and its somersloop output multiplier (applied to positive
 * i.e. output amounts only — Somersloops boost production, not input
 * consumption, matching the real game and PLAN.md §1's Manufacturer
 * example). `ZERO` if `part` isn't one of the recipe's parts.
 */
export function partRateAtMachineCount(profile: NodeProfile, part: string, machineCount: Rational): Rational {
  const ref = profile.refRatePerPart.get(part);
  if (!ref) return ZERO;
  const multiplier = isPositive(ref) ? profile.outputMultiplier : ONE;
  return multiply(multiply(machineCount, profile.clockFraction), multiply(ref, multiplier));
}

/**
 * Inverts `partRateAtMachineCount`: the machine count that makes `part`'s
 * rate equal `targetRate` (signed), at this node's own clock/shards.
 * `undefined` if `part` isn't one of the recipe's parts, or its reference
 * rate is zero (degenerate recipe data — never happens in practice, but
 * guards the division).
 */
export function machineCountForTargetRate(
  profile: NodeProfile,
  part: string,
  targetRate: Rational,
): Rational | undefined {
  const ref = profile.refRatePerPart.get(part);
  if (!ref || isZero(ref)) return undefined;
  const multiplier = isPositive(ref) ? profile.outputMultiplier : ONE;
  const perMachine = multiply(profile.clockFraction, multiply(ref, multiplier));
  if (isZero(perMachine)) return undefined;
  return divide(targetRate, perMachine);
}

/**
 * Signed power in MW at `machineCount` machines. The float boundary
 * (`@scm/rational`'s `powerAtClock`) — see PLAN.md §1's exactness-boundary
 * note. `0` if the node has no `effectivePower` at all (shouldn't happen
 * for any real machine, but some specialty/future node kinds might have
 * none).
 */
export function nodePower(profile: NodeProfile, machineCount: Rational): number {
  if (profile.syntheticPowerAtOneUnit !== undefined) {
    return profile.syntheticPowerAtOneUnit * toApproximateNumber(machineCount);
  }
  if (!profile.effectivePower) return 0;
  const perMachine = powerAtClock(profile.effectivePower, profile.clockFraction, profile.overclockExponent);
  return perMachine * toApproximateNumber(profile.powerMultiplier) * toApproximateNumber(machineCount);
}

export interface PinnedMachineCountResult {
  /** Present when `node.limit` was set and parsed/anchored successfully. */
  readonly count?: Rational;
  /** Present when `node.limit` was set but couldn't be turned into a machine count (bad string, or no usable primary part for `"ppm"` mode). */
  readonly issue?: string;
}

/**
 * The machine count directly implied by `node.limit`/`limitMode` — no
 * graph awareness. Returns `{}` (neither field set) when `node.limit` is
 * `null`, meaning "not pinned; the caller decides the default" (Manual
 * mode always defaults to `ONE`; Basic mode tries graph propagation first
 * and only then falls back to `ONE` — see `manual.ts`/`basic.ts`).
 */
export function pinnedMachineCount(profile: NodeProfile): PinnedMachineCountResult {
  const { node } = profile;
  if (node.limit === null || !profile.recipe) return {};

  let limitValue: Rational;
  try {
    limitValue = parseRational(node.limit);
  } catch {
    return { issue: `invalid limit "${node.limit}"` };
  }

  if (node.limitMode === "machines") {
    return { count: limitValue };
  }

  // "ppm": the limit is a target rate for the recipe's primary part.
  const part = profile.primaryPart;
  if (!part) {
    return { issue: 'limitMode "ppm" but the recipe has no part to anchor it to' };
  }
  const target = isPositive(part.amount) ? limitValue : negate(limitValue);
  const count = machineCountForTargetRate(profile, part.part, target);
  if (!count) {
    return { issue: `could not derive a machine count from the "ppm" limit on part "${part.part}"` };
  }
  return { count };
}
