// Parsed, in-memory domain types — every numeric field from the raw JSON has
// become a `Rational` by this point, except `Machine.overclockPowerExponent`,
// which is the one deliberate float boundary documented in PLAN.md §1 (it is
// used as a real-valued exponent, so it is converted to `number` at load time
// via `@scm/rational`'s `toApproximateNumber`). `Part.sinkPoints` and
// `Machine.maxProductionShards` were already plain JSON numbers (counts, not
// rates) and stay `number`.
import type { Rational } from "@scm/rational";

export interface Tier {
  /** The leading digit of a `"tier-milestone"` string, e.g. `6` in `"6-1"`. */
  readonly tier: number;
  /** The trailing digit, e.g. `1` in `"6-1"`. */
  readonly milestone: number;
  /** The original `"tier-milestone"` string, kept for display/debugging. */
  readonly raw: string;
}

export interface CostEntry {
  readonly part: string;
  readonly amount: Rational;
}

export interface Machine {
  readonly name: string;
  readonly tier: Tier;
  readonly averagePower?: Rational;
  readonly basePower?: Rational;
  readonly basePowerBoost?: Rational;
  readonly fueledBasePowerBoost?: Rational;
  readonly maxProductionShards?: number;
  readonly minPower?: Rational;
  /**
   * The float boundary: `game_data.json`'s `OverclockPowerExponent`
   * (canonically `1321929/1000000`) converted via `toApproximateNumber`.
   * Feed this straight into `@scm/rational`'s `powerAtClock` downstream —
   * do not re-derive it from a stored `Rational`, there isn't one.
   */
  readonly overclockPowerExponent?: number;
  readonly productionShardMultiplier?: Rational;
  readonly productionShardPowerExponent?: Rational;
  readonly cost: readonly CostEntry[];
}

export interface MultiMachineModel {
  readonly name: string;
  readonly partsRatio: Rational;
  readonly isDefault: boolean;
}

/** The kind of ratio a `MultiMachineCapacity` scales — parts/min, or power. */
export type MultiMachineRatioKind = "parts" | "power" | "none";

export interface MultiMachineCapacity {
  readonly name: string;
  readonly partsRatio?: Rational;
  readonly powerRatio?: Rational;
  readonly isDefault: boolean;
  readonly color?: number;
}

export interface MultiMachine {
  readonly name: string;
  readonly showPpm: boolean;
  readonly autoRound: boolean;
  /** `undefined` when the raw value was `""` (no default max) or absent. */
  readonly defaultMax?: Rational;
  /** Model variants (e.g. Miner Mk.1/2/3). Empty when the family has none. */
  readonly models: readonly MultiMachineModel[];
  /** Capacity variants (e.g. Impure/Normal/Pure). Empty when none exist. */
  readonly capacities: readonly MultiMachineCapacity[];
  /** Whether `capacities` (and `models`, when parts-ratio-based) scale parts or power. */
  readonly ratioKind: MultiMachineRatioKind;
}

export interface Part {
  readonly name: string;
  readonly tier: Tier;
  readonly sinkPoints: number;
  readonly fluid: boolean;
}

export interface RecipePart {
  readonly part: string;
  /** Signed: negative = input (consumed), positive = output (produced). */
  readonly amount: Rational;
}

export interface Recipe {
  readonly name: string;
  /** Raw `Recipe.Machine` string — resolve via `resolveMachine()` from `machines.ts`. */
  readonly machine: string;
  readonly batchTime: Rational;
  readonly tier: Tier;
  readonly parts: readonly RecipePart[];
  readonly alternate: boolean;
  readonly ficsmas: boolean;
  readonly ignoreInputMultiplier: boolean;
  readonly spaceElevatorMultiplier: boolean;
  /** Overrides the machine's own `averagePower` when present (Converter, Particle Accelerator, Quantum Encoder). */
  readonly averagePower?: Rational;
  readonly minPower?: Rational;
  /**
   * True when `parts` has no entry with a positive amount — the PLAN.md §1
   * definition of "generator" (23 recipes). Covers true power generators
   * (fuel in, power out via the machine's `averagePower`), Space Elevator
   * phases (parts in, nothing out), and the zero-part Geothermal
   * Generator/Resource Well Pressurizer recipes.
   */
  readonly isGenerator: boolean;
}

export interface GameData {
  readonly machines: readonly Machine[];
  readonly multiMachines: readonly MultiMachine[];
  readonly parts: readonly Part[];
  readonly recipes: readonly Recipe[];

  readonly machinesByName: ReadonlyMap<string, Machine>;
  readonly multiMachinesByName: ReadonlyMap<string, MultiMachine>;
  readonly partsByName: ReadonlyMap<string, Part>;
  readonly recipesByName: ReadonlyMap<string, Recipe>;

  /** Keyed by the raw `Recipe.machine` string (pre-MultiMachine-resolution). */
  readonly recipesByMachine: ReadonlyMap<string, readonly Recipe[]>;
  /** Recipes that consume a given part (a `Parts` entry with a negative amount). */
  readonly recipesByPartAsInput: ReadonlyMap<string, readonly Recipe[]>;
  /** Recipes that produce a given part (a `Parts` entry with a positive amount). */
  readonly recipesByPartAsOutput: ReadonlyMap<string, readonly Recipe[]>;
  /** All 23 recipes with `isGenerator: true` — see `Recipe.isGenerator`. */
  readonly generatorRecipes: readonly Recipe[];
}
