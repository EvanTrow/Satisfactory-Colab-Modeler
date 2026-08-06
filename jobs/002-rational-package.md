# Job 002: `packages/rational` — exact rational arithmetic

**Phase:** 0 · Foundations
**Status:** Not started
**Depends on:** 001 (monorepo scaffold — needs the empty `packages/rational` workspace to exist)

## Context

Read [`PLAN.md`](../PLAN.md) sections **1. Resource Inventory** (the "exact rational strings" finding and the `OverclockPowerExponent` caveat), **7. Project Structure** (key-libraries table: "Why a custom rational type"), and **9. Verification** (rationals bullet) before starting.

This is the single most foundational package in the whole app. `game_data.json` encodes every rate as an exact rational string (`"12/5"`, `"-9/5"`, `"1321929/1000000"`), and the tool's entire value proposition over web planners is exact arithmetic with no rounding. Every downstream package (`gamedata`, `solver`, `ydoc`) depends on this being correct.

## Scope

In scope:
- A `BigInt`-backed rational type (e.g. `Rational { numerator: bigint; denominator: bigint }`), always stored in canonical reduced form with a positive denominator.
- Arithmetic: `add`, `subtract`, `multiply`, `divide`, `negate`, `reciprocal`, `abs`.
- Comparison: `equals`, `compare` (for sorting), `isZero`, `isNegative`, `isPositive`.
- Parsing from strings covering every format the game data and UI need:
  - Simple fractions: `"12/5"`, `"-9/5"`.
  - Decimals: `"0.125"`, `"1321929/1000000"`-equivalent decimal input.
  - Mixed numbers: `"2 1/3"` (per PLAN.md's docs quote: limits accept "whole numbers, decimals, fractions (including mixed numbers)").
  - Plain integers: `"5"`, `"-3"`.
- Canonical `n/d` string formatting for storage (matches the Postgres `limit_exact`/`clock_exact` column format described in PLAN.md §4).
- A display/formatting function that supports both fraction and decimal output, digit limits, and rounding modes (this is the engine behind the "number-format settings" feature — just the pure formatting logic here, not the settings UI).
- A separate, clearly-named floating-point path for the one documented exception: `OverclockPowerExponent` power calculations (`power = base × clock^1.321929`) are irrational and must use `number`, not `Rational`. Provide a small helper (e.g. `powerAtClock(baseRational: Rational, clockRational: Rational, exponent: number): number`) that explicitly converts to float at the boundary, so it's obvious in code review where exactness is deliberately given up.
- Full unit test coverage (Vitest, matching the Vite/TS stack).

Out of scope:
- Anything that reads `game_data.json` (that's Job 003).
- Solver logic (Job 017).
- UI number-format *settings* (the toggle/preferences live in `doc_settings`/CRDT `settings`, wired up in later jobs — this job only provides the formatting primitives they'll call).

## Deliverables

- `packages/rational/src/rational.ts` (or similar) exporting the `Rational` type and arithmetic/comparison functions.
- `packages/rational/src/parse.ts` — string → `Rational` parser handling all formats above, throwing a clear error on invalid input.
- `packages/rational/src/format.ts` — `Rational` → string formatter (canonical `n/d`, decimal-with-precision, mixed-number display).
- `packages/rational/src/power.ts` — the float-boundary helper for `OverclockPowerExponent`.
- `packages/rational/src/index.ts` re-exporting the public API.
- Test suite covering arithmetic identities, canonical-form reduction, and round-trip parse/format.

## Acceptance criteria

Per PLAN.md §9's exact spec — implement these as real tests, not just informal checks:
- Property test: `(a/b + c/d) − c/d == a/b` exactly, for a range of generated fractions.
- Canonical form is always fully reduced (gcd-divided) with a positive denominator, including after every arithmetic op.
- Round-trips through parse → format → parse for at least `"2 1/3"`, `"-9/5"`, `"0.125"`, `"1321929/1000000"`.
- Parsing `game_data.json`-style strings like `"12/5"`, `"-9/5"`, `"1321929/1000000"` all succeed and produce the expected `Rational`.
- `pnpm --filter rational test` (or equivalent) passes with no failures; `pnpm --filter rational build` and `typecheck` are clean.
- No use of `number` for any value that flows through the rational arithmetic path — only at the explicit `power.ts` boundary.

## Notes for the worker

- BigInt division truncates toward zero in JS — be careful with GCD/reduction sign handling (canonical form: denominator always positive, sign lives on the numerator).
- Consider using the Euclidean algorithm for GCD on `bigint`.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
