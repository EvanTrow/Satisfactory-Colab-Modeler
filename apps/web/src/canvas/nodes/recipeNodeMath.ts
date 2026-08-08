// Pure, React-free math backing `RecipeNode.tsx` — deliberately isolated so
// it's unit-testable with vitest the same way Job 009's `filters.ts` is
// (see `recipeNodeMath.test.ts`), and so the "stopgap" per-part rate math
// this job's spec calls out lives in exactly one place for Job 017-019 to
// swap out once the real solver exists.
//
// ---------------------------------------------------------------------------
// On-the-wire format for `NodeRecord.limit`/`.clock` (this job's to decide,
// per jobs/007-ydoc-schema.md's deferral — see this job's Handoff notes for
// the full writeup Jobs 017-019 should read):
//
//   - `clock` is a canonical `@scm/rational` `n/d` string (via
//     `toFractionString`) representing a **percentage**, e.g. `"100"` for
//     100% clock, `"125/2"` for 62.5%. Range is nominally [1, 250] (a hard
//     cap of 250%, PLAN.md §2; a soft floor of 1%, this job's own choice —
//     see `MIN_CLOCK_PERCENT` below) but nothing below enforces that against
//     hand-written/imported doc data, only this module's own read/write
//     helpers.
//   - `limit` is a canonical `n/d` string in whatever unit `limitMode`
//     implies: parts-per-minute for `"ppm"`, machine count for `"machines"`.
//     No unit marker is stored — `limitMode` disambiguates.
//   - `null` (both fields) means "never explicitly set" — the UI computes
//     and displays a sensible default (see `effectiveClockPercent`/
//     `effectiveLimitValue`) but does NOT write it back until the user
//     actually interacts with the field. This preserves `null` as a
//     meaningful "untouched" sentinel, which the (not-yet-built) auto-round
//     feature (PLAN.md §2, explicitly out of scope for this job) will
//     likely want: "manually touching clock or limit switches auto-round
//     off" only makes sense if "touched" is distinguishable from "still at
//     its computed default".
// ---------------------------------------------------------------------------
import {
  baseRecipeRatePerMinute,
  defaultVariant,
  multiMachineRecipeRatePerMinute,
  resolveMachine,
  type GameData,
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
  equals,
  isNegative,
  isPositive,
  isZero,
  multiply,
  of,
  parseRational,
  type Rational,
} from "@scm/rational";
import type { LimitMode, NodeRecord } from "@scm/ydoc";

// ---------------------------------------------------------------------------
// Limit-mode defaulting (PLAN.md §2: "Miners and AWESOME Sinks default to
// parts-per-minute; everything else defaults to machine count").
// ---------------------------------------------------------------------------

/**
 * The two `Recipe.machine` values (pre-MultiMachine-resolution — see
 * `@scm/gamedata`'s `resolveMachine`) that default to ppm. Checked against
 * the *raw* recipe machine name, not the resolved concrete variant
 * (`"Miner"`, not `"Miner Mk.3"`) — this is the same field
 * `buildNodeInputForRecipe` (apps/web/src/panels/recipeChooser/filters.ts)
 * already has in hand at node-creation time, and matches PLAN.md §2's own
 * wording exactly ("Miners and AWESOME Sinks").
 */
const PPM_DEFAULT_MACHINES: ReadonlySet<string> = new Set(["Miner", "AWESOME Sink"]);

export function defaultLimitMode(recipeMachine: string): LimitMode {
  return PPM_DEFAULT_MACHINES.has(recipeMachine) ? "ppm" : "machines";
}

// ---------------------------------------------------------------------------
// Clock percent parsing/clamping.
// ---------------------------------------------------------------------------

/** Hard upper cap, per PLAN.md §2 ("capped at 250%"). */
export const MAX_CLOCK_PERCENT: Rational = of(250);
/**
 * Soft lower floor — PLAN.md §2 only documents the upper cap, but a clock of
 * 0% (or negative) makes "machines needed" mathematically undefined (division
 * by zero) and doesn't correspond to anything buildable in-game (Satisfactory
 * itself floors underclocking at a small positive percentage). Chosen here,
 * not sourced from `game_data.json` — flagged in this job's Handoff notes.
 */
export const MIN_CLOCK_PERCENT: Rational = of(1);

export function clampClockPercent(value: Rational): Rational {
  if (compare(value, MIN_CLOCK_PERCENT) < 0) return MIN_CLOCK_PERCENT;
  if (compare(value, MAX_CLOCK_PERCENT) > 0) return MAX_CLOCK_PERCENT;
  return value;
}

function safeParseRational(text: string | null | undefined, fallback: Rational): Rational {
  if (!text) return fallback;
  try {
    return parseRational(text);
  } catch {
    // Defensive only — every write this module's own callers make goes
    // through `toFractionString`, so this should never actually trigger
    // against locally-authored data. Guards against a hand-edited/corrupt
    // doc (or a future remote peer) crashing the node card instead of just
    // falling back to the default, matching PLAN.md §5's "a CRDT guarantees
    // convergence, not correctness" framing.
    return fallback;
  }
}

/** `node.clock`, parsed and clamped to `[MIN_CLOCK_PERCENT, MAX_CLOCK_PERCENT]`; `100` when unset. */
export function effectiveClockPercent(node: Pick<NodeRecord, "clock">): Rational {
  return clampClockPercent(safeParseRational(node.clock, of(100)));
}

// ---------------------------------------------------------------------------
// Recipe rate helpers.
// ---------------------------------------------------------------------------

/**
 * Picks the part that best represents "one unit of this recipe" for the
 * machine-count/ppm math below: the largest-magnitude **output** if the
 * recipe has any, else the largest-magnitude input (covers generators and
 * pure-consumer recipes, which have no positive-amount parts at all — see
 * `Recipe.isGenerator`). `undefined` for the two zero-part recipes in the
 * current dataset (Geothermal Generator, Resource Well Pressurizer).
 */
export function primaryPart(recipe: Pick<Recipe, "parts">): RecipePart | undefined {
  if (recipe.parts.length === 0) return undefined;
  const outputs = recipe.parts.filter((p) => isPositive(p.amount));
  const pool = outputs.length > 0 ? outputs : recipe.parts;
  return pool.reduce((best, part) => (compare(abs(part.amount), abs(best.amount)) > 0 ? part : best));
}

/**
 * The `machine`+`purity` pair a `NodeRecord` carries — together these fully
 * identify a MultiMachine variant (Job 009's Handoff notes: "There is no
 * need to re-derive `purity` separately from `machine` — both fields
 * together fully identify the variant"). `machine` alone is ambiguous for
 * capacity-only families (Geothermal Generator, Resource Well Extractor):
 * every capacity shares the same underlying `Machine` record/name, only the
 * ratio differs, so `purity` is required to pick the right one.
 */
export type MachineRef = Pick<NodeRecord, "machine" | "purity">;

function resolvedVariantFor(gameData: GameData, recipe: Recipe, ref: MachineRef): MultiMachineVariant | undefined {
  const resolved = resolveMachine(recipe.machine, gameData);
  if (resolved.kind === "machine") return undefined;

  const matches = resolved.variants.filter((v) => v.machine.name === ref.machine);
  if (matches.length <= 1) return matches[0] ?? defaultVariant(resolved);
  const byPurity = ref.purity ? matches.find((v) => v.capacity?.name.toLowerCase() === ref.purity) : undefined;
  return byPurity ?? matches[0];
}

/**
 * One machine's per-minute rate for `partName` at 100% clock speed —
 * `baseRecipeRatePerMinute` scaled by the resolved MultiMachine variant's
 * ratio when `ref` resolves to one. Signed like `RecipePart.amount`
 * (negative = consumption). `ZERO` if `ref` can't be resolved to any variant
 * at all (stale/corrupt `machine`/`purity`). Throws if `partName` isn't one
 * of `recipe`'s parts, same as `baseRecipeRatePerMinute`.
 */
export function ratePerMachineAtFullClock(
  gameData: GameData,
  recipe: Recipe,
  ref: MachineRef,
  partName: string,
): Rational {
  const resolved = resolveMachine(recipe.machine, gameData);
  if (resolved.kind === "machine") {
    return baseRecipeRatePerMinute(recipe, partName);
  }
  const variant = resolvedVariantFor(gameData, recipe, ref);
  if (!variant) return ZERO;
  return multiMachineRecipeRatePerMinute(recipe, partName, variant);
}

/** `ratePerMachineAtFullClock` for `recipe`'s `primaryPart` — the anchor `computeMachineCount` is built on. `ZERO` when `primaryPart` is `undefined` (zero-part recipes). */
export function referenceRateAtFullClock(gameData: GameData, recipe: Recipe, ref: MachineRef): Rational {
  const part = primaryPart(recipe);
  if (!part) return ZERO;
  return ratePerMachineAtFullClock(gameData, recipe, ref, part.part);
}

// ---------------------------------------------------------------------------
// Limit / machine-count derivation.
// ---------------------------------------------------------------------------

export type LimitNodeRef = MachineRef & Pick<NodeRecord, "limit" | "limitMode">;
export type ClockNodeRef = MachineRef & Pick<NodeRecord, "limit" | "limitMode" | "clock">;

/**
 * The value the limit field should *display* when `node.limit` is `null`
 * (never explicitly set): `1` machine for machine-count mode, or the primary
 * part's own 100%-clock rate for ppm mode (i.e. "one machine's worth").
 * Purely a display fallback — see the module header for why `null` is never
 * overwritten just from rendering this.
 */
export function effectiveLimitValue(gameData: GameData, recipe: Recipe, node: LimitNodeRef): Rational {
  if (node.limit) return safeParseRational(node.limit, ONE);
  return node.limitMode === "ppm" ? referenceRateAtFullClock(gameData, recipe, node) : ONE;
}

/**
 * The exact machine count implied by a node's current
 * `limit`/`limitMode`/`clock`, anchored so `limitMode: "machines"`'s `limit`
 * means exactly what it says **at 100% clock**, and clock changes solve for
 * how many actual machines are needed to keep hitting that same target
 * rate:
 *
 * ```
 * referenceRate  = primary part's rate, one machine, 100% clock
 * targetRate     = limitMode === "ppm" ? limit : limit × referenceRate
 * machineCount   = targetRate / (referenceRate × clock / 100)
 * ```
 *
 * Check: at `clock = 100`, `machineCount = targetRate / referenceRate =
 * limit` for machine-count mode — i.e. the anchor property holds exactly at
 * the moment a user types a limit value, which is what makes "limit" in
 * that mode readable as "N machines" at all. `ZERO` when the recipe has no
 * usable primary part, or the resolved machine/variant can't be found
 * (`referenceRate` is `ZERO` in both cases).
 */
export function computeMachineCount(gameData: GameData, recipe: Recipe, node: ClockNodeRef): Rational {
  const referenceRate = referenceRateAtFullClock(gameData, recipe, node);
  if (isZero(referenceRate)) return ZERO;

  const clockPercent = effectiveClockPercent(node);
  const limitValue = effectiveLimitValue(gameData, recipe, node);
  const targetRate = node.limitMode === "ppm" ? limitValue : multiply(limitValue, referenceRate);
  const perMachineNow = multiply(referenceRate, divide(clockPercent, of(100)));
  if (isZero(perMachineNow)) return ZERO;
  return divide(targetRate, perMachineNow);
}

/**
 * The job's documented stopgap "displayed rate" for one part row:
 * `machineCount × (that part's own 100%-clock rate) × clock/100`. Signed
 * like `RecipePart.amount`. Deliberately ignores every *other* node in the
 * graph (there is no solver yet — Jobs 017-019) — see this job's Handoff
 * notes ("Stopgap rate math") for the full rationale and what those jobs
 * need to replace this with.
 */
export function stopgapPartRate(
  gameData: GameData,
  recipe: Recipe,
  node: ClockNodeRef,
  part: RecipePart,
  machineCount: Rational = computeMachineCount(gameData, recipe, node),
): Rational {
  const rateAtFull = ratePerMachineAtFullClock(gameData, recipe, node, part.part);
  const clockFraction = divide(effectiveClockPercent(node), of(100));
  return multiply(multiply(machineCount, rateAtFull), clockFraction);
}

// ---------------------------------------------------------------------------
// Clock ± presets — the manual ± buttons step the clock through a fixed list
// of "sensible" percentages rather than solving for a whole machine count
// (superseded the original PLAN.md §2 "snap so machine count lands on a
// whole number" design — see this file's git history for that version).
// ---------------------------------------------------------------------------

/**
 * The manual ± buttons' fixed stops. 25-point spacing across the full
 * [1, 250] range, which conveniently lines up with Satisfactory's own Power
 * Shard mechanic — each shard raises a machine's overclock ceiling by 50%
 * (100% at 0 shards, 150% at 1, 200% at 2, 250% at 3) — so every shard-count
 * breakpoint a player would actually reach for is one of these stops, with a
 * quarter-step in between for finer adjustment. `1` (not `0`) is the floor
 * to match `MIN_CLOCK_PERCENT`.
 */
export const CLOCK_PRESETS: readonly Rational[] = [1, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250].map((n) =>
  of(n),
);

/** `"up"` = the **"+"** button (raises clock speed). `"down"` = the **"−"** button (lowers it). */
export type ClockStepDirection = "up" | "down";

/**
 * The next/previous value in `CLOCK_PRESETS` from `currentClockPercent`, in
 * the given direction. A value that isn't itself one of the presets
 * (freehand-typed, or imported from other data) simply moves to the nearest
 * preset in that direction — same as if it had started from there. Holds at
 * the first/last preset once there's nothing further in that direction (the
 * list's own endpoints already sit at `MIN_CLOCK_PERCENT`/`MAX_CLOCK_PERCENT`,
 * so this never needs a separate clamp).
 */
export function stepClockToPreset(currentClockPercent: Rational, direction: ClockStepDirection): Rational {
  if (direction === "up") {
    for (const preset of CLOCK_PRESETS) {
      if (compare(preset, currentClockPercent) > 0) return preset;
    }
    return CLOCK_PRESETS[CLOCK_PRESETS.length - 1];
  }
  for (let i = CLOCK_PRESETS.length - 1; i >= 0; i--) {
    if (compare(CLOCK_PRESETS[i], currentClockPercent) < 0) return CLOCK_PRESETS[i];
  }
  return CLOCK_PRESETS[0];
}

// ---------------------------------------------------------------------------
// Job 027's `autoRound.ts` still solves clock speed against a target whole
// machine count (a background, click-less feature — see that file's header
// for why it's genuinely different math from the ± buttons above). These
// primitives back that, not the manual buttons.
// ---------------------------------------------------------------------------

export interface ClockSnapResult {
  clockPercent: Rational;
  /** The machine count that actually results from `clockPercent` — exactly a whole number unless `clamped` is `true`. */
  machineCount: Rational;
  /** `true` when the exact target fell outside `[MIN_CLOCK_PERCENT, MAX_CLOCK_PERCENT]` and had to be clamped, in which case `machineCount` is the genuine (non-integer) count at the clamped clock, not the originally-targeted integer. */
  clamped: boolean;
}

/** Exported for `autoRound.ts` — nearest-integer rounding needs the same floor primitive. */
export function isIntegerRational(value: Rational): boolean {
  return value.denominator === 1n;
}

/** Floor toward −∞, exact (bigint division truncates toward zero, so negative non-exact values need a −1 correction). Exported for `autoRound.ts` (Job 027). */
export function floorToBigInt(value: Rational): bigint {
  const quotient = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  return remainder === 0n || value.numerator >= 0n ? quotient : quotient - 1n;
}

/**
 * Given the node's current `(clockPercent, machineCount)` pair and a desired
 * whole-number `targetCount`, solves `targetCount × newClock =
 * currentMachineCount × currentClockPercent` for `newClock`, clamped to
 * `[MIN_CLOCK_PERCENT, MAX_CLOCK_PERCENT]`. Used only by `autoRound.ts` now
 * (which picks `targetCount` via nearest-integer rounding) — the manual ±
 * buttons use the fixed `CLOCK_PRESETS` list above instead.
 */
export function deriveClockForTargetCount(
  currentClockPercent: Rational,
  currentMachineCount: Rational,
  targetCount: Rational,
): ClockSnapResult {
  const exactNewClock = divide(multiply(currentMachineCount, currentClockPercent), targetCount);
  const clampedClock = clampClockPercent(exactNewClock);
  const clamped = !equals(clampedClock, exactNewClock);
  const machineCount = clamped
    ? divide(multiply(currentMachineCount, currentClockPercent), clampedClock)
    : targetCount;
  return { clockPercent: clampedClock, machineCount, clamped };
}

// ---------------------------------------------------------------------------
// Somersloop clamping.
// ---------------------------------------------------------------------------

/** Clamps a shard count into `[0, maxShards]`, rounding to the nearest integer first (defensive against a fractional/NaN input from a stray UI event). */
export function clampShards(shards: number, maxShards: number): number {
  if (!Number.isFinite(shards)) return 0;
  const rounded = Math.round(shards);
  return Math.min(Math.max(rounded, 0), Math.max(maxShards, 0));
}

// ---------------------------------------------------------------------------
// Row order (drag-to-reorder).
//
// Persisted via `NodeRecord.priorityOrder` — the same generic
// `Y.Array<portId>` field Job 024's Splurger repurposes for its own
// top/bottom-tier encoding (`splurgerPassthrough.ts`'s
// `encode`/`decodePriorityOrder`). Here it's read as a flat list of this
// node's own `PartRow` handle ids (`"in:<part>"`/`"out:<part>"` — the exact
// ids `RecipeNode.tsx`'s `PartRow` already assigns its `Handle`s) in display
// order, ungrouped — `orderRecipeParts` is what re-splits it back into an
// inputs-then-outputs layout.
// ---------------------------------------------------------------------------

/** The `Handle`/drag id for `part` — `"in:<name>"` for a consumed part, `"out:<name>"` for a produced one, matching `RecipePart.amount`'s sign. */
export function partHandleId(part: Pick<RecipePart, "part" | "amount">): string {
  return `${isNegative(part.amount) ? "in" : "out"}:${part.part}`;
}

/**
 * `parts`, split into inputs/outputs (inputs first, matching the card's
 * left-input/right-output layout) and ordered within each group by
 * `priorityOrder`'s rank for that part's `partHandleId`. Parts absent from
 * `priorityOrder` (a fresh node, or a part added by a later `game_data.json`
 * update) keep their recipe-authored relative order and sort after every
 * part `priorityOrder` *does* rank — i.e. "explicitly placed rows first, new
 * rows appended at the end of their group." Stale `priorityOrder` entries
 * (a part no longer on this recipe) are simply never looked up, so they're
 * harmless dead weight rather than something this needs to filter out.
 */
export function orderRecipeParts(
  parts: readonly RecipePart[],
  priorityOrder: readonly string[],
): RecipePart[] {
  const rank = new Map(priorityOrder.map((id, index) => [id, index]));
  function byRank(a: RecipePart, b: RecipePart): number {
    const aRank = rank.get(partHandleId(a));
    const bRank = rank.get(partHandleId(b));
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return 0;
  }
  const inputs = parts.filter((part) => isNegative(part.amount)).sort(byRank);
  const outputs = parts.filter((part) => !isNegative(part.amount)).sort(byRank);
  return [...inputs, ...outputs];
}
