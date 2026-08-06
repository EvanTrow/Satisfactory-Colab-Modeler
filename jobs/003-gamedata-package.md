# Job 003: `packages/gamedata` — typed, indexed game database

**Phase:** 0 · Foundations
**Status:** Done
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

## Handoff notes

**Sourcing `game_data.json` (the job's open question):** read directly from `resources/`, not copied — there is exactly one copy of the file on disk, no sync step, no drift risk. `packages/gamedata/src/data.ts` does `import gameDataJson from "../../../resources/game_data/game_data.json"` (a relative import reaching outside the package to the repo-root `resources/` dir) and exports `defaultGameData: GameData = loadGameData(gameDataJson)`, computed once at module load. This works because `tsconfig.base.json` already sets `resolveJsonModule: true`, and I verified directly with `tsc` that a relative JSON import outside a package's `rootDir: "src"` compiles cleanly (TS's `rootDir` inference doesn't reject JSON module imports the way it would a stray `.ts` file outside the root) — both `typecheck` and `build` are clean with this import in place. `loadGameData(json: unknown): GameData` itself (in `load.ts`) stays pure/synchronous/JSON-import-free per the job spec — `data.ts` is the only file that touches `resources/`.
  - **Caveat for Jobs 008/009 (web app)**: this relative-import approach is verified for Node (Vitest, `tsc`, the Fastify api) but not yet exercised through Vite. Vite's dev server restricts serving files outside its detected project/workspace root (`server.fs.allow`); since `pnpm-workspace.yaml` lives at the repo root alongside `resources/`, Vite should auto-detect that as the workspace root and allow it, but this hasn't been confirmed against an actual `apps/web` Vite dev server yet. If it turns out to be blocked, the fix is a one-line `server.fs.allow` addition in `apps/web`'s Vite config — not a `gamedata` change.
  - (A stale `git status` snapshot early in this job's session made it look like `resources/` and `PLAN.md` were untracked. They aren't — `git log -- PLAN.md`/`git log -- resources/game_data/game_data.json` both show they were committed in `5e0ba82` "Job 001: monorepo scaffold", including all 204 files under `resources/images/icons/`. So the relative import above resolves correctly from a fresh clone of the committed history, not just in this working copy — no follow-up needed.)

**Public API — import everything from `@scm/gamedata`** (also JIT: `main`/`types`/`exports` point at `./src/index.ts`, no build step needed to consume it):

- **Loading:** `loadGameData(json: unknown): GameData` (`./load`) — validates (zod) and parses a raw `game_data.json`-shaped value, converting every numeric string to a `Rational` except `OverclockPowerExponent` (see below). Throws a zod `ZodError` or `RationalParseError` on malformed input. `defaultGameData: GameData` (`./data`) is the real data, already loaded — most consumers should just import this rather than calling `loadGameData` themselves. `GAME_DATA_VERSION = "unversioned"` (`./load`) is a hardcoded placeholder — `game_data.json` has no version field today; real versioning is PLAN.md §10.5's open question, deferred past this job.
- **Types** (`./types`): `GameData { machines, multiMachines, parts, recipes, machinesByName, multiMachinesByName, partsByName, recipesByName, recipesByMachine, recipesByPartAsInput, recipesByPartAsOutput, generatorRecipes }` (all `ReadonlyMap`/readonly arrays). `Machine`, `MultiMachine` (+`MultiMachineModel`, `MultiMachineCapacity`, `MultiMachineRatioKind`), `Part`, `Recipe` (+`RecipePart`), `Tier`, `CostEntry` — every numeric field is a `Rational` except `Machine.overclockPowerExponent: number` (the one deliberate float boundary, already converted via `@scm/rational`'s `toApproximateNumber` — feed it straight into `powerAtClock` downstream, there's no stored `Rational` to re-derive it from) and `Part.sinkPoints`/`Machine.maxProductionShards: number` (genuine integer counts in the source JSON, never rates). `Recipe.isGenerator: boolean` is true for the 23 recipes with no positive-amount part (fuel-in/power-out generators, Space Elevator phases, and the two zero-part recipes).
- **MultiMachine resolution** (`./machines`): `MULTI_MACHINE_RECIPE_NAMES` — the `Set` of the five names (`Miner`, `Oil Extractor`, `Resource Well Extractor`, `Geothermal Generator`, `Space Elevator`). `resolveMachine(name: string, gameData: GameData): ResolvedMachine` — discriminated union `{ kind: "machine"; machine }` | `{ kind: "multiMachine"; name; multiMachine; variants: MultiMachineVariant[] }`, where `variants` is the **full model × capacity crossing already computed** (length `max(1,models.length) × max(1,capacities.length)`; 9 for Miner, 3 for Oil Extractor/Resource Well Extractor/Geothermal Generator, 1 for Space Elevator). Each `MultiMachineVariant` carries `{ multiMachineName, model?, capacity?, machine, ratio, ratioKind, isDefaultModel, isDefaultCapacity }` — `ratio` is the combined `model.partsRatio × capacity's ratio` multiplier (defaults to `1` for whichever piece is absent). `findVariant(resolved, { model?, capacity? })` and `defaultVariant(resolved)` (picks the `Default: true` model+capacity, or the first variant if unmarked) are convenience lookups. `baseRecipeRatePerMinute(recipe, part): Rational` computes a recipe's inherent `(amount/batchTime)×60` rate for one part; `multiMachineRecipeRatePerMinute(recipe, part, variant): Rational` scales that by a variant's `ratio` — this pair is what proves the golden Miner Mk.3-on-Pure fact (base rate `1` × ratio `240×2=480` = `480/min`). Both plain-`Machines` and `MultiMachines` (`AWESOME Sink`, `Dimensional Depot Uploader`) that aren't in the special five still resolve correctly via `resolveMachine` (they fall through to the plain-`Machines` branch and succeed, since both also have a flat `Machines` entry) — no recipe ever names them, so this only matters if a later job resolves machine names from something other than `Recipe.machine`.
- **Somersloop boost** (`./somersloop`): `somersloopBoost(machine: Machine, shards: number): SomersloopBoost` → `{ shards, outputMultiplier: Rational, powerMultiplier: Rational }`. `outputMultiplier = 1 + shards × ProductionShardMultiplier`; `powerMultiplier = outputMultiplier ^ ProductionShardPowerExponent`, computed as an **exact `Rational`** via repeated multiplication (not the `power.ts` float boundary) — verified that `ProductionShardPowerExponent` is exactly the integer `2` for every machine in the current data, so this stays exact; the function throws if a future data revision ever ships a non-integer exponent rather than silently truncating. Throws if `shards` is negative, non-integer, or exceeds `machine.maxProductionShards`. Verifies the Manufacturer golden fact: 4 shards → `2×` output at `4×` power.
- **Tiers** (`./indices`): `parseTier(raw: string): Tier` (`"6-1"` → `{ tier: 6, milestone: 1, raw: "6-1" }`), `compareTiers(a, b): -1|0|1`.
- **Icons** (`./icons`): `iconFileName(displayName: string): string` (`"Iron Ore"` → `"Iron_Ore.png"`, pure, no I/O). `verifyIconCoverage(gameData, availableFiles: readonly string[], knownExtraFiles = KNOWN_NON_ENTITY_ICON_FILES): IconCoverageResult` → `{ missing, orphans, isComplete }` — deliberately takes the file list as a parameter (no `fs` import in this module) so it works unmodified in a browser bundle; the package's own `icons.test.ts` is what calls `node:fs`'s `readdirSync` against `resources/images/icons/` and feeds the result in. `KNOWN_NON_ENTITY_ICON_FILES = ["Conveyor_Merger.png", "Smart_Splitter.png"]` are PLAN.md §1's two documented logistics icons that aren't a part or machine — allowed by default so a correct 204-file directory reports zero orphans.

**Recipe-level power overrides (not explicitly called out in PLAN.md, found while building the schema):** `Recipe.averagePower`/`Recipe.minPower` exist and are populated for exactly 43 recipes, all on `Converter`/`Particle Accelerator`/`Quantum Encoder` — these three machines have no `AveragePower` of their own in `Machines` at all; their power is a per-recipe property instead of a fixed per-machine one. `Recipe.averagePower`, when present, should be treated as overriding `Machine.averagePower` for that recipe. Job 017 (solver) needs to know this — reading only `machine.averagePower` will silently give `undefined`/wrong power for those three machines' recipes.

**Verification actually run, all clean:**
- `pnpm --filter @scm/gamedata test` — 6 files, 40 tests passed, including: `loadGameData` parses the real `resources/game_data/game_data.json` with zero errors and produces the documented counts (32/7/170/332); every numeric field becomes a `Rational` except `overclockPowerExponent`; `DefaultMax: ""` maps to `undefined`; `isGenerator` is true for exactly 23 recipes; the `AveragePower` sign convention (Nuclear `+2500` generates, Manufacturer `-55` consumes); MultiMachine resolution for all five special names plus a sampled 19 plain machines (24 distinct `Recipe.machine` values total, 5 special-cased); the **Miner Mk.3-on-Pure = 480/min golden test** (both via the `ratio` field directly and via `multiMachineRecipeRatePerMinute` against the real "Iron Ore" recipe, plus all ten Miner recipes); the **Manufacturer + 4 somersloops = 2× output / 4× power golden test**; icon coverage against the real 204-file `resources/images/icons/` directory (zero missing, zero orphans).
- `pnpm --filter @scm/gamedata build` — clean; `dist/` contains only the 8 source modules (no test files leaked in, via `tsconfig.build.json` excluding `src/**/*.test.ts`, copying Job 002's pattern).
- `pnpm --filter @scm/gamedata typecheck` — clean.
- `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` — all clean across every workspace (nothing else broke; `rational`'s 67 tests and `gamedata`'s 40 both pass).
- `pnpm lint` (root flat ESLint config) — clean, no new rules needed.

**Deviations from the spec:**
- Added `packages/gamedata/src/types.ts` (domain types) and `packages/gamedata/src/data.ts` (the `defaultGameData` singleton + the `resources/` import) beyond the deliverables list's named files — both are small, focused additions that keep `load.ts`/`schema.ts` from also owning type definitions and I/O sourcing, not a scope change.
- `resolveMachine` returns the **full model × capacity crossing already computed** (`variants: MultiMachineVariant[]`) rather than a lazy `(modelName?, capacityName?) => variant` selector — the job's own golden example ("Mk.3 × Pure") reads more naturally as picking one item out of a precomputed crossing than as a two-argument selector call, and it lets `findVariant`/`defaultVariant` stay simple pure lookups.
- `zod@4.4.3` pinned exactly (matching the version already resolved transitively in `pnpm-lock.yaml` via other tooling), rather than a caret range, to avoid a second zod version being installed.
- Added `packages/gamedata/tsconfig.build.json`, copying Job 002's test-file-exclusion pattern (the job file's own Notes section explicitly suggested this).

**Nothing else flagged as a concern for Jobs 007/009/017**, beyond the `resources/` git-tracking question above and the Converter/Particle Accelerator/Quantum Encoder recipe-level power override noted above.
