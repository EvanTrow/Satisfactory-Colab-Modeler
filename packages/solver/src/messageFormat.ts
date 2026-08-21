// Human-readable rate formatting for solver-generated issue/warning text
// (rate-mismatch and overflow messages in `edgeValidation.ts`, `full.ts`,
// `edgeResolution.ts`). Deliberately distinct from `toFractionString`, which
// those same modules use for `rate`/`limit`/`machineCount` DATA fields (the
// lossless storage format re-parsed and formatted per the user's own
// `NumberFormats` setting downstream — see `apps/web/src/canvas/formatRate.ts`).
// Message text is plain, static strings with no such re-formatting step, so
// a fraction like "133/3/min" would reach the user verbatim — always render
// it as a decimal instead.
import { toDecimalString, type Rational } from "@scm/rational";

export function formatRateForMessage(value: Rational): string {
  return toDecimalString(value, { digits: 3 });
}
