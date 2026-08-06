// Somersloop production-shard boost, per PLAN.md §1: data-driven via a
// machine's `MaxProductionShards` / `ProductionShardMultiplier` /
// `ProductionShardPowerExponent`.
//
// `outputMultiplier = 1 + shards × ProductionShardMultiplier`
// `powerMultiplier  = outputMultiplier ^ ProductionShardPowerExponent`
//
// Verified against every machine in the current `game_data.json`:
// `ProductionShardPowerExponent` is always the exact integer `2`, so the
// power multiplier stays an exact `Rational` (repeated multiplication) —
// this is *not* the same float boundary as `OverclockPowerExponent`
// (`power.ts` in `@scm/rational`), which is a genuinely fractional exponent.
// If a future `game_data.json` revision ever ships a non-integer
// `ProductionShardPowerExponent`, `somersloopBoost` throws rather than
// silently truncating — see `integerPow` below.
import { ONE, ZERO, add, multiply, of, type Rational } from "@scm/rational";
import type { Machine } from "./types";

export interface SomersloopBoost {
  readonly shards: number;
  readonly outputMultiplier: Rational;
  readonly powerMultiplier: Rational;
}

/** Exact `base ^ exponent` for a non-negative integer-valued `Rational` exponent. */
function integerPow(base: Rational, exponent: Rational): Rational {
  if (exponent.denominator !== 1n) {
    throw new Error(
      `somersloopBoost: ProductionShardPowerExponent must be an integer, got ${exponent.numerator}/${exponent.denominator}`,
    );
  }
  if (exponent.numerator < 0n) {
    throw new Error("somersloopBoost: ProductionShardPowerExponent must not be negative");
  }
  let result = ONE;
  for (let i = 0n; i < exponent.numerator; i++) {
    result = multiply(result, base);
  }
  return result;
}

/**
 * Computes the output/power multipliers for running `machine` with `shards`
 * production shards inserted. `shards` must be a non-negative integer no
 * greater than `machine.maxProductionShards` (machines that don't support
 * shards at all have `maxProductionShards` of `undefined`, i.e. a max of 0).
 *
 * Verifies PLAN.md §1's Manufacturer example: `MaxProductionShards: 4`,
 * `ProductionShardMultiplier: 1/4`, `ProductionShardPowerExponent: 2` →
 * 4 shards gives `outputMultiplier = 1 + 4×(1/4) = 2`,
 * `powerMultiplier = 2² = 4`.
 */
export function somersloopBoost(machine: Machine, shards: number): SomersloopBoost {
  const max = machine.maxProductionShards ?? 0;
  if (!Number.isInteger(shards) || shards < 0) {
    throw new Error(`somersloopBoost: shard count must be a non-negative integer, got ${shards}`);
  }
  if (shards > max) {
    throw new Error(
      `somersloopBoost: ${machine.name} supports at most ${max} production shard(s), got ${shards}`,
    );
  }
  if (shards === 0) {
    return { shards, outputMultiplier: ONE, powerMultiplier: ONE };
  }

  const multiplier = machine.productionShardMultiplier ?? ZERO;
  const exponent = machine.productionShardPowerExponent ?? ONE;
  const outputMultiplier = add(ONE, multiply(of(shards), multiplier));
  const powerMultiplier = integerPow(outputMultiplier, exponent);

  return { shards, outputMultiplier, powerMultiplier };
}
