// The plain-data input boundary for `packages/solver` — deliberately NOT
// Yjs-shaped (PLAN.md §7: "packages/solver takes a plain snapshot and
// returns plain results. No Yjs import, no DOM."). `apps/web`'s worker host
// (Job 018) constructs one of these from the live `@scm/ydoc` CRDT document
// on every solve; this package never imports `@scm/ydoc`, `yjs`, React, or
// any DOM API — it only knows about this file's types.
//
// Field shapes deliberately mirror the on-the-wire conventions Job 010
// already locked in for `@scm/ydoc`'s `NodeRecord` (see
// `apps/web/src/canvas/nodes/recipeNodeMath.ts`'s header comment), since
// that is what Job 018 will actually have on hand to convert:
//   - `limit`/`clock` are canonical `@scm/rational` `n/d` strings (parsed via
//     `parseRational` at this module's consumers, never left as raw
//     strings past the node-profile boundary — see `nodeProfile.ts`).
//   - `clock` is a **percentage** (`"100"` = 100%), not a 0..1 fraction.
//   - `limit` is in whatever unit `limitMode` implies: parts-per-minute for
//     `"ppm"`, machine count for `"machines"`.
//   - `null` (both fields) means "never explicitly set" — see
//     `nodeProfile.ts`'s `pinnedMachineCount` for how each mode defaults it.
//
// `recipe`/`machine` are plain `@scm/gamedata` name strings (e.g.
// `"Iron Ingot"` / `"Smelter"`, or `"Iron Ore"` / `"Miner Mk.3"`) — this
// package resolves them against a `GameData` at solve time, it does not
// re-validate or index the game data itself (that's `@scm/gamedata`'s job).

/** The three calculators this job implements. `"full"` is Job 023's job. */
export type SolverMode = "none" | "manual" | "basic";

export type LimitMode = "machines" | "ppm";

export type Purity = "impure" | "normal" | "pure";

export interface SolverNode {
  readonly id: string;
  /**
   * The `@scm/gamedata` `Recipe.name` this node runs. This job models
   * recipe nodes only — specialty node kinds (splurger, storage container,
   * outpost, AWESOME Sink, blueprint, etc. — PLAN.md §2) have no solver
   * representation yet; see this package's Handoff notes for what a later
   * job needs to add to extend the snapshot for them.
   */
  readonly recipe: string;
  /**
   * The concrete machine/variant name to run the recipe on, e.g.
   * `"Smelter"` for a plain machine, or `"Miner Mk.3"` for a MultiMachine
   * model variant. Resolved against `recipe`'s own `Machine`/`MultiMachine`
   * family via `@scm/gamedata`'s `resolveMachine` — see `nodeProfile.ts`.
   */
  readonly machine: string;
  /**
   * Disambiguates a MultiMachine capacity variant (Miner/Oil
   * Extractor/Resource Well Extractor/Geothermal Generator) when `machine`
   * alone doesn't uniquely identify one. `null` for non-MultiMachine
   * recipes and machine families with no capacity list (Space Elevator).
   */
  readonly purity: Purity | null;
  /** Canonical `@scm/rational` `n/d` string, or `null` if never set. */
  readonly limit: string | null;
  readonly limitMode: LimitMode;
  /** Canonical `@scm/rational` `n/d` string **percentage**, or `null` (defaults to 100). */
  readonly clock: string | null;
  /** Production shard (Somersloop) count; 0 for machines that don't support them. */
  readonly shards: number;
}

export interface SolverEdge {
  readonly id: string;
  /** The `@scm/gamedata` `Part.name` this connection carries. */
  readonly part: string;
  readonly fromNode: string;
  readonly fromPort: string;
  readonly toNode: string;
  readonly toPort: string;
}

export interface SolverSnapshot {
  readonly nodes: readonly SolverNode[];
  readonly edges: readonly SolverEdge[];
}
