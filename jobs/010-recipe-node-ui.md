# Job 010: Recipe node UI

**Phase:** 2 · Solo canvas editor
**Status:** Done
**Depends on:** 009 (Recipe Chooser — needs nodes to actually be created first)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce** ("Set a limit", "Clock speed", "Auto-round" rows) and **3. Feature Scope → MVP → Canvas & editing** ("recipe nodes with title, machine icon, per-part input/output rows, limit field, clock-speed field with ± snapping, and somersloop count"). This job builds the real node card that Job 009 currently stubs.

## Scope

In scope:
- A React Flow custom node component rendering, per node:
  - Title (recipe name) and machine icon (from `packages/gamedata`'s icon manifest, Job 003).
  - Per-part rows: one row per `Parts` entry on the recipe, showing icon, part name, and a **live computed rate** — for this job, before the solver exists (Job 017), display the rate as "limit × recipe ratio" using pure client-side math against the node's own `limit`/`clock` fields (not a real graph solve; that's what makes this "Manual"-adjacent display legitimate to build before the solver package exists — document this clearly as a stopgap in Handoff notes, since Job 017-019 will replace/wire it to real solver output).
  - Limit field at the bottom: defaults to parts-per-minute for Miners/AWESOME Sinks, machine-count for everything else (per PLAN.md §2's exact default rule).
  - Clock-speed numeric field with **± buttons that snap clock so machine count lands on a whole number** (minus rounds count up, plus rounds count down), capped at 250% — implement the snapping math using `packages/rational` (Job 002), not floats.
  - Somersloop count field/stepper, capped at the machine's `MaxProductionShards` (from `packages/gamedata`).
  - Input/output ports as distinct connection handles per part (React Flow handles) — ports themselves aren't wired to edges yet (Job 011), but the handle elements must exist and be positioned correctly (inputs left, outputs right, or whatever matches the reference tool's convention).
- Auto-round toggle is **out of scope for this job** (PLAN.md marks it a later phase — "Later phases: … auto-round mode") — only build the manual ± snap behavior described above.
- Red/orange validity highlighting is **out of scope** here too (that depends on solver output, Job 019) — but leave a clearly-named prop/slot (e.g. `validityState`) on the node component so Job 019 can wire it without a rewrite.
- Editing the limit or clock field directly (typing a value) updates the node's Yjs state via `packages/ydoc` mutations.

Out of scope:
- Actual solver-computed rates (Jobs 017-019) — use the documented stopgap math only.
- Connections between nodes (Job 011).
- Multi-select/marquee, cut/copy/paste (Job 012).
- Red/orange highlighting, summary panel (Job 019).
- Visual polish beyond "functionally correct and legible" (Job 014 does the real Ferrumium-inspired pass).

## Deliverables

- `apps/web/src/canvas/nodes/RecipeNode.tsx` (or similar) — the full node card.
- Clock ± snapping logic using `packages/rational`, unit tested against known cases (e.g. clock at 100% with a limit that isn't a whole machine count, pressing "+" should land on the next whole-machine-count clock ≤ current, capped at 250%).
- Limit-mode defaulting logic (ppm for Miner/AWESOME Sink, machine-count otherwise).
- Somersloop stepper respecting `MaxProductionShards` from gamedata.

## Acceptance criteria

- Creating a recipe node (via Job 009's chooser) renders title, icon, part rows, limit field (correctly defaulted), clock field, and somersloop stepper.
- Editing limit/clock/shards updates the underlying Yjs node map (verify by reading doc state after an edit).
- Clock ± snapping produces exact whole-machine-count results, verified with `packages/rational`-based tests, and is capped at 250%.
- Somersloop stepper cannot exceed the resolved machine's `MaxProductionShards`.
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- Keep the stopgap "displayed rate" math isolated (e.g. a single clearly-named function) so it's a one-place swap when Job 019 wires real solver output in.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).

## Handoff notes

### What got built

- `apps/web/src/canvas/nodes/recipeNodeMath.ts` — all the pure, React-free logic (unit-testable without any DOM/React Flow setup, same pattern Job 009's `filters.ts` used): `defaultLimitMode`, the clock-percent parse/clamp helpers, `primaryPart`/`ratePerMachineAtFullClock`/`referenceRateAtFullClock` (recipe-rate math, MultiMachine-variant-aware), `effectiveClockPercent`/`effectiveLimitValue`/`computeMachineCount` (the limit/clock → machine-count derivation), `stopgapPartRate` (the per-row displayed rate), and `snapClockToWholeMachineCount` (the ± button math). Extensive header comments in the file explain the "why" of each piece — read those before changing anything here.
- `apps/web/src/canvas/nodes/recipeNodeMath.test.ts` — 27 vitest tests: `defaultLimitMode` for Miner/AWESOME Sink vs everything else, `primaryPart` against a normal recipe/a generator recipe (falls back to inputs)/a zero-part recipe, rate helpers cross-checked against `defaultGameData` real data (including PLAN.md's own "Miner Mk.3 on Pure = 480/min" example, and a purity-disambiguation regression test for capacity-only families like Geothermal Generator), `computeMachineCount`/`stopgapPartRate` against a real Iron Plate/Constructor recipe (both limit modes, both a 100% and a 150% clock), `snapClockToWholeMachineCount`'s pure cases (non-integer floor/ceil, integer ±1, both the 250%-upper and 1%-lower clamp paths with the "genuine resulting count isn't whole" assertion), and two full-pipeline round-trip tests (snap → re-derive `computeMachineCount` from scratch at the new clock → assert the recount is exactly whole).
- `apps/web/src/canvas/nodes/validityState.ts` — the `RecipeNodeValidityState`/`RecipeNodeValidity` placeholder types for Job 019 (see "The `validityState` slot" below).
- `apps/web/src/canvas/nodes/RecipeNode.tsx` — the node card component: header (machine icon + recipe name + machine name, `· Generator` suffix when `recipe.isGenerator`), one row per `recipe.parts` entry (icon, part name, stopgap rate, a port `Handle`), and a footer with the limit field, clock field + ± buttons, and a somersloop stepper, plus an "≈ N machines" readout. Falls back to a small red "Unknown recipe" card if `node.recipe` doesn't resolve against `defaultGameData` (a stale/future `game_data.json` version — PLAN.md §10's open question), rather than crashing.
- `apps/web/src/canvas/nodes/index.ts` — barrel for the above.
- `apps/web/src/assets/icons.ts` (+ `icons.test.ts`) — `getIconUrl(displayName)`, resolving a part/machine display name to its bundled icon URL via `import.meta.glob`. See "Icon serving" below.
- `apps/web/src/canvas/useYjsSync.ts` — `nodeRecordToFlowNode` now sets `type: "recipe"` for `kind: "recipe"` nodes (was always `"default"`); `CanvasNodeData` gained the `validityState` slot.
- `apps/web/src/canvas/CanvasView.tsx` — registers `nodeTypes = { recipe: RecipeNode }` on `<ReactFlow>` (as a module-level constant, not created inside the component, per React Flow's own guidance against a fresh object identity every render).
- `apps/web/src/canvas/index.ts` — re-exports `RecipeNode`/`defaultLimitMode`/the validity types.
- `apps/web/src/panels/recipeChooser/filters.ts` — `buildNodeInputForRecipe` now sets `limitMode: defaultLimitMode(recipe.machine)` instead of always `"machines"` (Job 009 explicitly deferred this rule to this job). `filters.test.ts`'s Miner default-variant test now also asserts `limitMode === "ppm"`.
- `apps/web/package.json` — added `@scm/rational: workspace:*` as a runtime dependency (needed directly for the first time in `apps/web`; previously only `@scm/gamedata`/`@scm/ydoc` were listed, and `@scm/gamedata` doesn't re-export `@scm/rational`'s runtime functions, only its `Rational` *type*).

### On-the-wire format for `limit`/`clock` — read this before Job 017-019

Both fields are `@scm/rational` canonical `n/d` strings (`toFractionString`'s output — the same lossless format `game_data.json` and the Postgres `limit_exact`/`clock_exact` projection columns already use), or `null`.

- **`clock`** encodes a **percentage directly**, e.g. `"100"` = 100% clock, `"125/2"` = 62.5%. Not a 0–1 fraction. Range is nominally `[1, 250]` (`MIN_CLOCK_PERCENT`/`MAX_CLOCK_PERCENT` in `recipeNodeMath.ts`) — the 250% upper cap is from PLAN.md §2 directly; the 1% lower floor is this job's own choice (nothing in `game_data.json` specifies one) and is easy to change in one place if a future job disagrees. `RecipeNode` clamps into this range on every write (both the ± buttons and manual typing); nothing in `packages/ydoc`'s schema enforces it against out-of-band writes.
- **`limit`** is in whatever unit `limitMode` implies — parts-per-minute for `"ppm"`, machine count for `"machines"` — with no unit marker in the string itself; `limitMode` disambiguates.
- **`null` means "never explicitly touched"**, deliberately kept distinct from any concrete value (including the computed default that value would otherwise show). `RecipeNode` computes and *displays* a sensible fallback when `null` (`effectiveLimitValue`/`effectiveClockPercent` in `recipeNodeMath.ts`: `1` machine, or the primary part's 100%-clock rate for ppm mode; `100` for clock) but does **not** write it back just from rendering — only an actual user edit (blur/Enter on the text field) or an actual ± button press writes a value. This was a deliberate choice to keep `null` meaningful for the not-yet-built auto-round feature (PLAN.md §2, explicitly out of scope here): "manually touching clock or limit switches auto-round off" only makes sense if "touched" is distinguishable from "still showing its computed default." **If Job 027 (auto-round) needs a different sentinel scheme, this is the one place that convention lives.**

### How machine count is derived (the core of the clock-snapping math)

There is no solver yet, so "machine count" for a node is derived purely from that node's own `limit`/`limitMode`/`clock`, anchored so that `limitMode: "machines"`'s `limit` means exactly what it says **at 100% clock**:

```
referenceRate = the recipe's primaryPart's rate for one machine at 100% clock
                 (largest-magnitude output if any, else largest-magnitude input —
                 covers generators/pure-consumers with no outputs at all)
targetRate    = limitMode === "ppm" ? limit : limit × referenceRate
machineCount  = targetRate / (referenceRate × clock / 100)
```

Check: at `clock = 100`, `machineCount = limit` exactly for machine-count mode — that's what makes "limit" in that mode readable as "N machines" at all, and it's what the clock ± buttons then perturb away from and back to a whole number.

`snapClockToWholeMachineCount(currentClockPercent, currentMachineCount, direction)` (the function backing the ± buttons) deliberately does **not** take a `GameData`/`Recipe`/`NodeRecord` — only the already-derived `(clock, count)` pair. The reason: `machineCount × clockPercent` is invariant as long as `limit`/`limitMode` don't change (both scale identically through the formula above), so solving `targetCount × newClock = currentCount × currentClock` for `newClock` never needs the recipe at all. This is what makes the function trivially unit-testable with bare `Rational` numbers (see the "pure cases" describe block in the test file) independent of any gamedata fixture.

Direction naming: `"roundUp"` is the **"−"** button (PLAN.md: "minus rounds count up" — i.e. *more* machines, which needs a *lower* clock since count ∝ 1/clock). `"roundDown"` is the **"+"** button (fewer machines, higher clock). If already at a whole number, ± still moves by exactly one machine (not a no-op) — "−" goes to `count + 1`, "+" to `count − 1`. The result is clamped into `[MIN_CLOCK_PERCENT, MAX_CLOCK_PERCENT]`; `ClockSnapResult.clamped` is `true` when clamping meant the snap couldn't fully land, in which case `.machineCount` is the genuine (non-integer) resulting count at the clamped clock, not the originally-targeted integer — `RecipeNode` doesn't currently surface `clamped` in the UI (nothing in the acceptance criteria asked for it), but the data is there for whoever wants to.

### Stopgap "displayed rate" math

`stopgapPartRate(gameData, recipe, node, part, machineCount?)` = `machineCount × (that part's own 100%-clock rate) × clock/100`. It is entirely local to the node — it does not look at any other node or edge in the document, which is exactly why it's legitimate to build before `packages/solver` exists (Jobs 017-019): once a real graph solve exists, a node's actual throughput depends on what's actually connected to it (a starved input clamps output, etc.), which this function cannot know. When Job 017-019 lands, the natural swap is: keep `RecipeNode.tsx`'s `<PartRow rate={...}>` call site, but feed it the solver's per-node-per-part result instead of `stopgapPartRate`'s output — the function's signature was kept narrow (recipe/node/part only, no React) specifically so that swap doesn't ripple anywhere else.

### Icon serving — the Job 003 caveat is resolved, no Vite config changes needed

`apps/web/src/assets/icons.ts` uses `import.meta.glob("../../../../resources/images/icons/*.png", { eager: true, query: "?url", import: "default" })` to eagerly resolve all 204 icon files to their served/bundled URLs at import time, then looks them up by filename via `@scm/gamedata`'s `iconFileName`.

The open caveat Job 003 flagged ("Vite's `server.fs.allow` restricts files outside the workspace root") turned out to be a non-issue: Vite's dev-server file-serving allowlist defaults to the *workspace root*, not `apps/web`'s own project root, and it detects the workspace root by walking up looking for (among other markers) a `pnpm-workspace.yaml` — which lives at this repo's actual root, one level above `apps/`. So the whole repo, including `resources/`, was already inside the allowed-to-serve root with zero config changes. Verified concretely in this job's manual testing: every icon `<img>` loaded with a `200`/`304` over `/@fs/...` in `pnpm dev`, and `pnpm --filter web build` successfully copied all 204 PNGs into `dist/assets/` with content hashes (confirmed both by inspecting the build output and by the production build completing without error). If a later job ever narrows `server.fs.allow` explicitly (e.g. for a security hardening pass), it needs to keep the repo root allowed or re-do this as an explicit `publicDir`/copy-step instead.

### Port handle id contract for Job 011

Every part row renders exactly one `<Handle>`, `id={`${"in"|"out"}:${part.part}`}` — e.g. `"in:Iron Ingot"`, `"out:Iron Plate"`. Direction follows `RecipePart.amount`'s sign (negative = input = `"in"`/`type="target"`/`Position.Left`; positive = output = `"out"`/`type="source"`/`Position.Right`). Verified live via `document.querySelectorAll('.react-flow__handle')` against a real "Heavy Modular Frame" node (4 inputs + 1 output) — `data-handleid`/`data-handlepos` matched the contract exactly for all 5 rows. Rows are visually sorted inputs-first, outputs-second (stable sort, does not change `recipe.parts`' underlying order or the handle ids), so "inputs left, outputs right" reads as two stacked groups rather than interleaved. Job 011 should be able to target `sourceHandle`/`targetHandle` using exactly this `"in:"`/`"out:"` + part-name scheme without needing to re-derive it from `recipe.parts` itself.

One thing Job 011 needs to know: a part name is **not guaranteed unique across a single recipe's input and output sides in general** (none of the 332 recipes in the current dataset actually do this, but nothing prevents it) — the `"in:"`/`"out:"` prefix exists specifically so an input and output row for the same part name never collide on handle id.

### The `validityState` slot for Job 019

`CanvasNodeData.validityState?: RecipeNodeValidityState | null` (`useYjsSync.ts`), always `null` as of this job (`nodeRecordToFlowNode` sets it explicitly). The type (`apps/web/src/canvas/nodes/validityState.ts`):

```ts
type RecipeNodeValidity = "valid" | "invalid" | "mismatched";
interface RecipeNodeValidityState {
  overall: RecipeNodeValidity;
  fields?: Partial<Record<"limit" | "clock" | "shards", RecipeNodeValidity>>;
}
```

`RecipeNode.tsx` accepts `data.validityState` (it's right there on `props.data`, already threaded through) but does not yet render anything different for a non-null value — Job 019 computing red/orange highlighting from solver output just needs to populate this field (e.g. by mapping the derived value over the `nodes` array before/while producing what gets handed to `<ReactFlow nodes={...}>`) and add the actual conditional styling inside `RecipeNode.tsx`. No prop-shape changes needed on `RecipeNode`'s side.

### Limit-mode defaulting

`defaultLimitMode(recipeMachine: string): LimitMode` checks the recipe's **raw**, pre-MultiMachine-resolution `Recipe.machine` field (`"Miner"`/`"AWESOME Sink"` → `"ppm"`, everything else → `"machines"`) — not the resolved concrete variant name (`"Miner Mk.3"`). This is applied once, at node-creation time, inside `buildNodeInputForRecipe` (`filters.ts`). AWESOME Sink itself is unreachable through the current Recipe Chooser (per Job 009's own Deviations note — no recipe's `machine` field is ever `"AWESOME Sink"`, it's a specialty node type nothing creates yet), so only the Miner half of this rule is exercised by anything reachable in the app today; both halves are unit-tested directly against the pure function regardless.

### Verification actually performed

- `pnpm --filter web test` — 44/44 tests pass (14 pre-existing `filters.test.ts` + 3 new `icons.test.ts` + 27 new `recipeNodeMath.test.ts`).
- `pnpm --filter web build`/`typecheck` — clean; the build output includes all 204 icon PNGs under `dist/assets/` with content hashes, plus the pre-existing >500KB chunk-size *warning* (not an error, not addressed here, same as Jobs 008/009 noted).
- `pnpm -r build`/`typecheck` — clean across all 9 buildable workspaces.
- `pnpm --filter '!@scm/api' -r test` — clean (`rational` 67, `ydoc` 25, `gamedata` 40, `web` 44 — 176 tests total). `apps/api`'s own suite still fails on the same pre-existing "no local Postgres" issue Jobs 007/008/009 documented; confirmed via `git status` that no `apps/api` file was touched.
- `pnpm lint` — clean, exit 0.
- **Manual browser verification**, via the Browser MCP tools against the `web-qa` dev server config with `main.tsx` temporarily pointed at `<CanvasView>` directly (Job 008/009's bypass approach), reverted afterward (confirmed via `git diff --stat apps/web/src/main.tsx` producing no output):
  - Created an "Iron Ore" node via the chooser, picking Miner Mk.3 × Pure in the variant picker. The rendered card showed the machine icon, "Iron Ore" title, "Miner Mk.3" subtitle, one part row (icon + "Iron Ore" + "480/min", matching PLAN.md's own documented Mk.3-on-Pure example exactly) with a right-side output handle, a "Limit (ppm)" field defaulted to `480`, "Clock" at `100%`, and "Somersloops 0/0" (Miner correctly has no shard slots — `maxProductionShards` undefined, buttons disabled). Confirmed via `window.__sfmDoc` that `limitMode: "ppm"` was set at creation and `limit`/`clock` were still `null` (the display-only-default behavior working as designed).
  - Edited the limit field directly (typed values including a mixed number `"...1/2"` and plain decimals) and confirmed via `window.__sfmDoc` after each edit that `updateNode` wrote a canonical `toFractionString` value, and that the part-row rate and the "≈ N machines" readout re-rendered live and matched hand-computed exact-fraction expectations.
  - **Clock ± snapping**, the acceptance criterion needing the most care: with `limit = "960511/200"` (ppm) and `clock` starting `null` (100%), computed by hand that `machineCount ≈ 10.0053` (non-integer). Clicked the "+" button (by precise `getBoundingClientRect()`-derived coordinates, after discovering the accessibility-tree ref-based click coordinates were unreliable post-re-render and had been landing on the *adjacent* "−" button in an earlier pass of this same test — a tooling artifact of this session, not a code bug, resolved by querying live DOM coordinates instead of reusing stale refs) three times in a row and independently recomputed the exact `machineCount` after each click using hand-rolled `BigInt` rational arithmetic in the page console (mirroring `computeMachineCount`'s formula, not calling any of this job's own code): `12/1` → `11/1` → `10/1`, each exactly whole. Clicked "−" once afterward and confirmed it went back to exactly `11/1`. This matches `recipeNodeMath.test.ts`'s unit tests exactly and confirms the full pipeline (button → `snapClockToWholeMachineCount` → `updateNode` → Yjs → re-render → `computeMachineCount`) round-trips to exact whole-machine-count results as required.
  - Created a "Heavy Modular Frame" node (Manufacturer, `maxProductionShards: 4`, matching PLAN.md §1's own documented example). Confirmed 4 input rows + 1 output row, each with a correctly-sided/typed `Handle` (checked via `document.querySelectorAll('.react-flow__handle')`'s `data-handleid`/`data-handlepos` attributes). Clicked the somersloop "+" button 5 times total; `window.__sfmDoc` showed `shards: 2` after 2 clicks and `shards: 4` (not 5) after all 5 — confirming `clampShards` correctly caps at the resolved machine's real `MaxProductionShards`.
  - Checked `read_network_requests` for all `.png` requests during this session: every icon (`Miner_Mk.3.png`, `Iron_Ore.png`, `Manufacturer.png`, and all 5 Heavy Modular Frame part icons) loaded with `200 OK` (or `304 Not Modified` on repeat) via Vite's `/@fs/...` dev route — direct confirmation the icon-serving approach works with zero `vite.config.ts` changes.
  - Console errors: checked via `read_console_messages` after all of the above — zero errors.

### Deviations from the spec / things flagged for later jobs

- **`MIN_CLOCK_PERCENT = 1` (a 1% floor) is this job's own addition**, not sourced from PLAN.md (which only documents the 250% upper cap) or from `game_data.json`. Without some floor, a degenerate limit/clock combination can drive the required clock toward zero, which is undefined for the `machineCount = target/perMachine` formula. If a later job finds a better-sourced floor (e.g. matching the actual game's minimum underclock percentage), `recipeNodeMath.ts`'s `MIN_CLOCK_PERCENT` constant is the one place to change it.
- **No manual limit-mode toggle UI was built** — only the creation-time default (ppm for Miner/AWESOME Sink, machines otherwise) from this job's Deliverables. `NodeRecord.limitMode` is technically still `updateNode`-able by anything that wants to add a toggle later; `RecipeNode.tsx` just doesn't expose one. This matches the job file's own Deliverables wording ("Limit-mode defaulting logic"), not an oversight.
- **The "≈ N machines" readout and the disabled-state of the clock ± buttons when the recipe has no usable reference rate** (the two zero-part recipes, Geothermal Generator/Resource Well Pressurizer) are this job's own additions beyond the letter of the acceptance criteria, added because they made manual verification of the exact-machine-count claim actually checkable in the UI rather than only in `window.__sfmDoc`. Should be harmless for later jobs to keep, remove, or restyle.
- **Auto-round and red/orange highlighting are untouched**, exactly as scoped out. The `validityState` slot (see above) is the only forward-looking hook this job added for Job 019; nothing was added anticipating auto-round's specific mechanics beyond keeping `null` a meaningful sentinel (see the wire-format section above).
- No changes were needed to `packages/gamedata` or `packages/rational` — both packages' existing public APIs (Job 002/003) already exposed everything this job needed. `packages/ydoc`'s schema was also untouched (Job 007's `string | null` typing for `limit`/`clock` already accommodated this job's chosen format with no migration needed).
