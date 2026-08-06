// BigInt-backed exact rational arithmetic. See PLAN.md §7 and
// jobs/002-rational-package.md for context: this package is the foundation
// every other package builds numeric correctness on, since game_data.json
// encodes every game rate as an exact rational string.

export type { Rational } from "./rational";
export {
  ZERO,
  ONE,
  makeRational,
  of,
  fromBigInt,
  add,
  subtract,
  multiply,
  divide,
  negate,
  reciprocal,
  abs,
  compare,
  equals,
  isZero,
  isNegative,
  isPositive,
} from "./rational";

export { parseRational, RationalParseError } from "./parse";

export type { RoundingMode, FormatStyle, FormatOptions, DecimalFormatOptions } from "./format";
export { formatRational, toFractionString, toMixedNumberString, toDecimalString } from "./format";

// The one deliberate float boundary — see power.ts for why this exists.
export { powerAtClock, toApproximateNumber } from "./power";
