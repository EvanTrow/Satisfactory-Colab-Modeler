# Job 003: `packages/gamedata` — typed, indexed game database

**Phase:** 0 · Foundations
**Status:** Not started
**Depends on:** 001 (monorepo scaffold)

## Context

Read [`PLAN.md`](../PLAN.md) section **1. Resource Inventory** in full before starting — it documents the exact shape of `resources/game_data/game_data.json` and every quirk you need to handle correctly (MultiMachine resolution, generators, somersloop math, tiers, alternates, fluids). Also skim `resources/game_data/game_data.json` and `resources/languages/translations/en-US.json` directly.

This package turns the raw JSON into a typed, validated, indexed in-memory database that the canvas, solver, and Recipe Chooser all query. Get the modeling of `Machine` vs `MultiMachine` resolution right here — every later feature depends on it.

## Scope

In scope:
- Zod (or similar) schemas validating the shape of `Machines`, `MultiMachines`, `Parts`, `Recipes` from `game_data.json`, using [`packages/rational`](../packages/rational) (Job 002) to parse every numeric-string field (`Amount`, `BatchTime`, `PartsRatio`, `PowerRatio`, `AveragePower`, `OverclockPowerExponent`, `ProductionShardMultiplier`, `ProductionShardPowerExponent`, etc.) into `Rational` at load time — never leave these as raw strings past the parsing boundary.
- A loader function, e.g. `loadGameData(json: unknown): GameData`, that validates and parses the whole file, throwing descriptive errors on malformed input.
- Indices built at load time:
  - Recipes by part (both as input and as output) — needed by the Recipe Chooser and by "what can produce/consume X" queries.
  - Recipes by machine name.
  - **MultiMachine resolution**: `Recipe.Machine` resolves against the union of `Machines` and `MultiMachines`. Implement the specific five-name mapping (`Miner`, `Oil Extractor`, `Resource Well Extractor`, `Geothermal Generator`, `Space Elevator` → `MultiMachines`; everything else → `Machines`), and expose a typed resolver, e.g. `resolveMachine(name: string): ResolvedMachine`, that returns a discriminated union distinguishing plain machines from MultiMachine variants (model × capacity crossing, e.g. Mk.3 × Pure).
  - Generator detection: recipes with no positive-`Amount` parts (23 of them) — expose a flag or a separate index, since these consume fuel and produce power via the machine's `AveragePower`, not via `Parts`.
  - Somersloop math: expose the boost formula as a function using `MaxProductionShards` / `ProductionShardMultiplier` / `ProductionShardPowerExponent` (verify Manufacturer's case: 4 slugs → `1 + 4×(1/4) = 2×` output at `2² = 4×` power) — a pure function taking shard count and returning output/power multipliers as `Rational`/float per the exactness rules from Job 002.
  - Tier parsing: `"tier-milestone"` strings (`"0-0"`…`"9-5"`) into a comparable structure for progression filtering.
- An icon manifest: a pure function mapping part/machine display name → icon filename (`"Iron Ore"` → `"Iron_Ore.png"`), matching the space→underscore rule documented in PLAN.md §1. Verify against the actual files in `resources/images/icons/` (204 files) — assert at build/test time that every part and machine resolves to a file that exists, and that there are no orphan icon files.
- Unit tests covering the specific verifiable facts from PLAN.md: Mk.3 Miner on Pure = 480/min; Manufacturer 4-somersloop = 2× output / 4× power; correct MultiMachine vs Machine resolution for all five special names; generator sign convention (`AveragePower` positive = generates, negative = consumes).

Out of scope:
- Solver logic that consumes this data to compute a factory (Job 017).
- UI/Recipe Chooser components (Job 009) — this job only needs to expose data these will query.
- `game_data_version` migration/versioning logic (that's a Phase-1+/open-question concern per PLAN.md §10.5 — just expose whatever version identifier is present in the file, if any, or a hardcoded constant if none exists).

## Deliverables

- `packages/gamedata/src/schema.ts` — Zod schemas for the raw JSON shape.
- `packages/gamedata/src/load.ts` — `loadGameData` parsing + validating + converting numeric strings to `Rational`.
- `packages/gamedata/src/machines.ts` — MultiMachine resolution logic.
- `packages/gamedata/src/indices.ts` — recipes-by-part, recipes-by-machine, generator index, tier utilities.
- `packages/gamedata/src/somersloop.ts` — boost formula.
- `packages/gamedata/src/icons.ts` — icon manifest / filename resolver + coverage assertion.
- `packages/gamedata/src/index.ts` — public API.
- Tests covering all the "Deliverables" bullets above and the specific golden facts from PLAN.md §1 and §9.
- A copy of or reference to `resources/game_data/game_data.json` wired into the package (either read at runtime from `resources/`, or copied into the package with a documented sync step — pick whichever keeps a single source of truth and document the choice in this file's Handoff notes).

## Acceptance criteria

- `loadGameData` successfully parses the real `resources/game_data/game_data.json` with zero validation errors.
- Icon coverage test passes: all 170 parts + 32 machines resolve to an existing file in `resources/images/icons/`, and no icon file is orphaned (matches PLAN.md's "exactly complete" claim — treat any mismatch as a bug to report, not silently ignore).
- Golden-value tests pass: Miner Mk.3 on Pure = 480/min (as an exact `Rational`); Manufacturer + 4 somersloops = 2× output at 4× power.
- MultiMachine resolution is correct for all five special-cased machine names and falls through correctly for the other 27.
- `pnpm --filter gamedata test/build/typecheck` all pass.

## Notes for the worker

- Every numeric field from the JSON must become a `Rational` (via Job 002's parser) at the load boundary — don't let raw strings or floats leak past `load.ts`.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md), and note in Handoff notes how you sourced `game_data.json` into the package (copied vs. read from `resources/`).
