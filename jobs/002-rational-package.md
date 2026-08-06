# Job 002: `packages/rational` — exact rational arithmetic

**Phase:** 0 · Foundations
**Status:** Done
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

## Handoff notes

**Public API — import everything from `@scm/rational`** (the package is JIT — `main`/`types`/`exports` point straight at `./src/index.ts`, no build step needed to consume it):

- **Type:** `Rational { readonly numerator: bigint; readonly denominator: bigint }`. Always canonical: denominator > 0, numerator/denominator coprime, zero is always `{0n, 1n}`. Never hand-construct a `Rational` object literal — always go through the constructors/operators below, which preserve the invariant.
- **Constructors:** `makeRational(numerator: bigint, denominator: bigint): Rational` (reduces to canonical form, throws on zero denominator), `of(numerator: bigint | number, denominator?: bigint | number = 1): Rational` (ergonomic literal constructor — `number` args must be safe integers), `fromBigInt(value: bigint): Rational`, constants `ZERO`, `ONE`.
- **Arithmetic:** `add`, `subtract`, `multiply`, `divide` (all `(a: Rational, b: Rational) => Rational`; `divide` throws on divide-by-zero), `negate(a)`, `reciprocal(a)` (throws on zero), `abs(a)`.
- **Comparison:** `compare(a, b): -1 | 0 | 1`, `equals(a, b): boolean` (cross-multiplies, so it's safe even against non-canonical input), `isZero`, `isNegative`, `isPositive`.
- **Parsing:** `parseRational(input: string): Rational` from `./parse` — handles plain integers (`"5"`, `"-3"`), simple fractions (`"12/5"`, `"-9/5"`), decimals (`"0.125"`, `".5"`, `"5."`), and mixed numbers (`"2 1/3"`, `"-2 1/3"`). Throws `RationalParseError` (also exported) on anything else, with the offending input in the message. **This is the function `packages/gamedata` should call on every numeric string field in `game_data.json`** (`Amount`, `BatchTime`, `PartsRatio`/`PowerRatio`, `AveragePower`, `OverclockPowerExponent`, `ProductionShardMultiplier`, etc.) — every sampled value in the current `resources/game_data/game_data.json` is a plain integer or a simple signed fraction, both handled directly by the fraction/integer branches (no decimals or mixed numbers actually appear in the data; those formats exist for future user-facing input, e.g. limit fields).
- **Formatting** (`./format`): `toFractionString(r): string` — canonical `n/d`, but **whole numbers render with no denominator** (`"5"`, not `"5/1"`) to match `game_data.json`'s own style and the `limit_exact`/`clock_exact` Postgres columns. `toMixedNumberString(r): string` (`"2 1/3"`, `"-1/3"` for proper fractions, `"5"` for integers). `toDecimalString(r, { digits?, rounding?, trimTrailingZeros? }): string` — exact `bigint`-based long division, no float involved even for the rounding step; `rounding` is `"round" | "floor" | "ceil" | "truncate"`, `digits` defaults to 6, `trimTrailingZeros` defaults to true. `formatRational(r, { style?: "fraction" | "mixed" | "decimal", ...decimal options }): string` dispatches to the above (defaults to `"fraction"`).
- **Float boundary** (`./power`): `powerAtClock(baseRational: Rational, clockRational: Rational, exponent: number): number` implements `power = base × clock^exponent` — the *only* function in the package that returns `number`. `toApproximateNumber(r: Rational): number` is the (also `power.ts`-only) `Rational`→`number` conversion it's built on; use it to convert a parsed `OverclockPowerExponent` `Rational` into the `exponent: number` argument. Every other function in the package stays entirely in `Rational`/`bigint` — no `Number()` conversions anywhere else in the source.

**Testing:** Vitest wasn't wired up anywhere in the repo yet, so it was added as a `packages/rational` devDependency (`vitest@^4.1.10`, no separate `vite.config.ts` needed — it runs standalone with the default Node environment). Added scripts: `packages/rational/package.json` `"test": "vitest run"`; root `turbo.json` gained a `"test"` task (`dependsOn: ["^build"]`); root `package.json` gained a `"test": "turbo run test"` script. So `pnpm --filter rational test` and `pnpm -r test` both work now (other packages simply have no `test` script yet, which turbo skips without failing). 67 tests across 5 files, all passing.

**Build note:** `packages/rational/tsconfig.json` (used by `typecheck`) includes `*.test.ts` so test-file type errors are still caught. A new `packages/rational/tsconfig.build.json` (extends the base, excludes `src/**/*.test.ts`) is what the `build` script actually invokes, so `dist/` only contains the public API, not compiled test files. If other packages add tests later, consider copying this split rather than letting `tsc -p tsconfig.json` emit test files into `dist/`.

**Verification actually run, all clean:**
- `pnpm --filter @scm/rational test` — 5 files, 67 tests passed.
- `pnpm --filter @scm/rational build` — clean, `dist/` contains only `index`, `rational`, `parse`, `format`, `power` (`.js`/`.d.ts`/maps).
- `pnpm --filter @scm/rational typecheck` — clean.
- `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` — all clean across every workspace (nothing else broke).
- `pnpm lint` (root flat ESLint config) — clean, no new rules needed.

**Deviations from the spec:** None substantive. One addition beyond the literal deliverables list: `tsconfig.build.json` (not mentioned in the job file) to keep compiled test files out of `dist/` — a build-hygiene detail, not a scope change. `toApproximateNumber` was added as a small named export from `power.ts` (the job file only explicitly names `powerAtClock`) so `gamedata`/`solver` have an official, clearly-labeled way to turn the parsed `OverclockPowerExponent` `Rational` into the `number` that `powerAtClock`'s `exponent` parameter expects, without reaching for an ad hoc `Number(...)` themselves.

**Nothing to flag as a concern for Job 003** — the parser handles every numeric string shape actually present in `resources/game_data/game_data.json` (verified by sampling `Amount` values via grep: only plain signed integers and simple signed fractions appear).
