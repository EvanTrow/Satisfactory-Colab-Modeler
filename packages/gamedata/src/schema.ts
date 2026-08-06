// Zod schemas for the raw shape of `resources/game_data/game_data.json`.
//
// These describe the JSON exactly as it appears on disk (`PascalCase` keys,
// numeric values still strings) and validate only *shape* + *parseability* of
// numeric strings. Converting those strings into `Rational`s happens one
// layer up, in `load.ts` — this module never imports `@scm/rational`'s
// arithmetic, only `parseRational`, and only to power the `.refine()` checks
// below so malformed numeric strings fail validation with a useful zod path
// (e.g. `Machines[3].AveragePower`) instead of surfacing as an opaque
// `RationalParseError` deeper in `load.ts`.
import { z } from "zod";
import { parseRational } from "@scm/rational";

function isParseableRational(value: string): boolean {
  try {
    parseRational(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A non-empty string that `parseRational` can parse. Used for every numeric
 * field in the game data except `MultiMachine.DefaultMax`, which is the one
 * field that legitimately appears as `""` (meaning "no default max") — see
 * `OptionalRationalStringSchema`.
 */
const RationalStringSchema = z.string().min(1).refine(isParseableRational, {
  message: "must be a valid rational string (integer, fraction, or decimal)",
});

/**
 * Like `RationalStringSchema`, but also accepts `""`. Only
 * `MultiMachine.DefaultMax` uses this — two of the seven `MultiMachines`
 * (`AWESOME Sink`, `Dimensional Depot Uploader`) encode "no default max" as
 * an empty string rather than omitting the field. `load.ts` maps `""` to
 * `undefined`.
 */
const OptionalRationalStringSchema = z
  .string()
  .refine((value) => value === "" || isParseableRational(value), {
    message: 'must be "" or a valid rational string',
  });

const RawCostEntrySchema = z.object({
  Part: z.string(),
  Amount: RationalStringSchema,
});

export const RawMachineSchema = z.object({
  Name: z.string(),
  Tier: z.string(),
  AveragePower: RationalStringSchema.optional(),
  BasePower: RationalStringSchema.optional(),
  BasePowerBoost: RationalStringSchema.optional(),
  FueledBasePowerBoost: RationalStringSchema.optional(),
  MaxProductionShards: z.number().int().nonnegative().optional(),
  MinPower: RationalStringSchema.optional(),
  OverclockPowerExponent: RationalStringSchema.optional(),
  ProductionShardMultiplier: RationalStringSchema.optional(),
  ProductionShardPowerExponent: RationalStringSchema.optional(),
  Cost: z.array(RawCostEntrySchema).optional(),
});

const RawMultiMachineModelSchema = z.object({
  Name: z.string(),
  PartsRatio: RationalStringSchema,
  Default: z.boolean().optional(),
});

const RawMultiMachineCapacitySchema = z.object({
  Name: z.string(),
  PartsRatio: RationalStringSchema.optional(),
  PowerRatio: RationalStringSchema.optional(),
  Default: z.boolean().optional(),
  Color: z.number().optional(),
});

export const RawMultiMachineSchema = z.object({
  Name: z.string(),
  ShowPpm: z.boolean().optional(),
  AutoRound: z.boolean().optional(),
  DefaultMax: OptionalRationalStringSchema.optional(),
  Machines: z.array(RawMultiMachineModelSchema).optional(),
  Capacities: z.array(RawMultiMachineCapacitySchema).optional(),
});

export const RawPartSchema = z.object({
  Name: z.string(),
  Tier: z.string(),
  SinkPoints: z.number(),
  Fluid: z.boolean().optional(),
});

const RawRecipePartSchema = z.object({
  Part: z.string(),
  // Signed: negative = input, positive = output. See PLAN.md §1.
  Amount: RationalStringSchema,
});

export const RawRecipeSchema = z.object({
  Name: z.string(),
  Machine: z.string(),
  BatchTime: RationalStringSchema,
  Tier: z.string(),
  Parts: z.array(RawRecipePartSchema),
  Alternate: z.boolean().optional(),
  Ficsmas: z.boolean().optional(),
  IgnoreInputMultiplier: z.boolean().optional(),
  SpaceElevatorMultiplier: z.boolean().optional(),
  // Only present on a handful of variable-power machines (Converter,
  // Particle Accelerator, Quantum Encoder) where power is a per-recipe
  // property rather than a fixed per-machine one — overrides the machine's
  // own `AveragePower`/`MinPower` when present.
  AveragePower: RationalStringSchema.optional(),
  MinPower: RationalStringSchema.optional(),
});

export const RawGameDataSchema = z.object({
  Machines: z.array(RawMachineSchema),
  MultiMachines: z.array(RawMultiMachineSchema),
  Parts: z.array(RawPartSchema),
  Recipes: z.array(RawRecipeSchema),
});

export type RawGameData = z.infer<typeof RawGameDataSchema>;
export type RawMachine = z.infer<typeof RawMachineSchema>;
export type RawMultiMachine = z.infer<typeof RawMultiMachineSchema>;
export type RawPart = z.infer<typeof RawPartSchema>;
export type RawRecipe = z.infer<typeof RawRecipeSchema>;
