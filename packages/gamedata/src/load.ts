// `loadGameData` — the single entry point that turns raw
// `game_data.json`-shaped JSON into a typed, validated, `Rational`-exact,
// indexed `GameData`. Every numeric string field becomes a `Rational` here
// (via `@scm/rational`'s `parseRational`) except `OverclockPowerExponent`,
// which becomes a plain `number` — see the comment on
// `Machine.overclockPowerExponent` in `types.ts` for why.
import { parseRational, toApproximateNumber } from "@scm/rational";
import {
  RawGameDataSchema,
  type RawMachine,
  type RawMultiMachine,
  type RawPart,
  type RawRecipe,
} from "./schema";
import type {
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
} from "./types";
import { buildRecipeIndices, parseTier } from "./indices";

/**
 * `game_data.json` carries no version field of its own (verified: the file's
 * only top-level keys are `Machines`/`MultiMachines`/`Parts`/`Recipes`).
 * PLAN.md §10.5 flags real game-data versioning/migration as an open
 * Phase-1+ question — out of scope here. This constant is the placeholder
 * the job file explicitly allows ("a hardcoded constant if none exists");
 * whichever job wires up `projects.game_data_version` should revisit this
 * once multiple `game_data.json` revisions actually need to coexist.
 */
export const GAME_DATA_VERSION = "unversioned" as const;

function parseCost(cost: RawMachine["Cost"]): CostEntry[] {
  return (cost ?? []).map((entry) => ({
    part: entry.Part,
    amount: parseRational(entry.Amount),
  }));
}

function parseMachine(raw: RawMachine): Machine {
  return {
    name: raw.Name,
    tier: parseTier(raw.Tier),
    averagePower: raw.AveragePower !== undefined ? parseRational(raw.AveragePower) : undefined,
    basePower: raw.BasePower !== undefined ? parseRational(raw.BasePower) : undefined,
    basePowerBoost:
      raw.BasePowerBoost !== undefined ? parseRational(raw.BasePowerBoost) : undefined,
    fueledBasePowerBoost:
      raw.FueledBasePowerBoost !== undefined ? parseRational(raw.FueledBasePowerBoost) : undefined,
    maxProductionShards: raw.MaxProductionShards,
    minPower: raw.MinPower !== undefined ? parseRational(raw.MinPower) : undefined,
    overclockPowerExponent:
      raw.OverclockPowerExponent !== undefined
        ? toApproximateNumber(parseRational(raw.OverclockPowerExponent))
        : undefined,
    productionShardMultiplier:
      raw.ProductionShardMultiplier !== undefined
        ? parseRational(raw.ProductionShardMultiplier)
        : undefined,
    productionShardPowerExponent:
      raw.ProductionShardPowerExponent !== undefined
        ? parseRational(raw.ProductionShardPowerExponent)
        : undefined,
    cost: parseCost(raw.Cost),
  };
}

/** Determines whether a MultiMachine family's capacities scale parts or power (or neither, e.g. Space Elevator). */
function inferRatioKind(raw: RawMultiMachine): MultiMachineRatioKind {
  const usesPower = (raw.Capacities ?? []).some((c) => c.PowerRatio !== undefined);
  if (usesPower) return "power";
  const usesParts =
    (raw.Machines ?? []).some((m) => m.PartsRatio !== undefined) ||
    (raw.Capacities ?? []).some((c) => c.PartsRatio !== undefined);
  return usesParts ? "parts" : "none";
}

function parseMultiMachine(raw: RawMultiMachine): MultiMachine {
  const models: MultiMachineModel[] = (raw.Machines ?? []).map((m) => ({
    name: m.Name,
    partsRatio: parseRational(m.PartsRatio),
    isDefault: m.Default ?? false,
  }));

  const capacities: MultiMachineCapacity[] = (raw.Capacities ?? []).map((c) => ({
    name: c.Name,
    partsRatio: c.PartsRatio !== undefined ? parseRational(c.PartsRatio) : undefined,
    powerRatio: c.PowerRatio !== undefined ? parseRational(c.PowerRatio) : undefined,
    isDefault: c.Default ?? false,
    color: c.Color,
  }));

  return {
    name: raw.Name,
    showPpm: raw.ShowPpm ?? false,
    autoRound: raw.AutoRound ?? false,
    // "" means "no default max" (AWESOME Sink, Dimensional Depot Uploader).
    defaultMax:
      raw.DefaultMax !== undefined && raw.DefaultMax !== ""
        ? parseRational(raw.DefaultMax)
        : undefined,
    models,
    capacities,
    ratioKind: inferRatioKind(raw),
  };
}

function parsePart(raw: RawPart): Part {
  return {
    name: raw.Name,
    tier: parseTier(raw.Tier),
    sinkPoints: raw.SinkPoints,
    fluid: raw.Fluid ?? false,
  };
}

function parseRecipeParts(parts: RawRecipe["Parts"]): RecipePart[] {
  return parts.map((p) => ({ part: p.Part, amount: parseRational(p.Amount) }));
}

function parseRecipe(raw: RawRecipe): Recipe {
  const parts = parseRecipeParts(raw.Parts);
  return {
    name: raw.Name,
    machine: raw.Machine,
    batchTime: parseRational(raw.BatchTime),
    tier: parseTier(raw.Tier),
    parts,
    alternate: raw.Alternate ?? false,
    ficsmas: raw.Ficsmas ?? false,
    ignoreInputMultiplier: raw.IgnoreInputMultiplier ?? false,
    spaceElevatorMultiplier: raw.SpaceElevatorMultiplier ?? false,
    averagePower: raw.AveragePower !== undefined ? parseRational(raw.AveragePower) : undefined,
    minPower: raw.MinPower !== undefined ? parseRational(raw.MinPower) : undefined,
    // PLAN.md §1: "Generators are recipes with no positive parts" (23 of them).
    isGenerator: !parts.some((p) => p.amount.numerator > 0n),
  };
}

/**
 * Validates and parses a raw `game_data.json`-shaped value into a typed,
 * `Rational`-exact, indexed `GameData`. Throws a descriptive error (a zod
 * `ZodError` for shape/format problems, or a `RationalParseError` for a
 * numeric string zod's `.refine()` didn't already catch) on malformed input.
 */
export function loadGameData(json: unknown): GameData {
  const raw = RawGameDataSchema.parse(json);

  const machines = raw.Machines.map(parseMachine);
  const multiMachines = raw.MultiMachines.map(parseMultiMachine);
  const parts = raw.Parts.map(parsePart);
  const recipes = raw.Recipes.map(parseRecipe);

  const machinesByName = new Map(machines.map((m) => [m.name, m]));
  const multiMachinesByName = new Map(multiMachines.map((m) => [m.name, m]));
  const partsByName = new Map(parts.map((p) => [p.name, p]));
  const recipesByName = new Map(recipes.map((r) => [r.name, r]));

  return {
    machines,
    multiMachines,
    parts,
    recipes,
    machinesByName,
    multiMachinesByName,
    partsByName,
    recipesByName,
    ...buildRecipeIndices(recipes),
  };
}
