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

/**
 * The four calculators PLAN.md §2 names. `"full"` (Job 023) models
 * even-split preference AND two-tier priority routing at splitters/mergers
 * as an exact-rational LP — see `full.ts`.
 */
export type SolverMode = "none" | "manual" | "basic" | "full";

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
  /**
   * Job 026 (Blueprints, PLAN.md §10.3): present ONLY for a synthetic
   * "blueprint compound" node standing in for an entire blueprint
   * container's flattened internal subgraph, collapsed to ONE node whose
   * machine count represents the blueprint's COPY COUNT. `recipe`/
   * `machine`/`purity`/`clock`/`shards` are ignored entirely for such a
   * node (there is no real recipe to resolve); `limit`/`limitMode` are
   * still honored normally — a blueprint's `Container.copiesLimit`, when
   * set, is encoded as an ordinary `limit`/`"machines"` pin on this node
   * (see `apps/web/src/workers/blueprintCollapse.ts`), reusing the exact
   * same pin-vs-propagate mechanism every other node already has rather
   * than inventing a second "soft cap" concept.
   *
   * When set, this node's per-part rates come directly from
   * `perCopyRates` (signed canonical `n/d` strings — positive = produced,
   * negative = consumed, exactly `RecipePart.amount`'s own convention, for
   * ONE copy) instead of a `@scm/gamedata` recipe/machine lookup — see
   * `nodeProfile.ts`'s `buildBlueprintCompoundProfile`. This is what lets
   * the copy count participate in the SAME fixed-point propagation
   * (`basic.ts`/`full.ts`) as every real node, resolved from whichever
   * neighbor's demand reaches the blueprint's boundary ports, rather than
   * being computed as a separate pass and multiplied in afterward — see
   * jobs/026-blueprints.md's Handoff notes ("How PLAN.md §10.3 was
   * resolved") for the full reasoning and its documented limitations.
   */
  readonly blueprintCopyBasis?: {
    readonly perCopyRates: Readonly<Record<string, string>>;
    /** Signed MW at exactly 1 copy — the float power boundary, same as every other node's `power` field. */
    readonly perCopyPowerMW: number;
  };
  /**
   * Storage Container support: an UPPER BOUND on this node's own resolved
   * machine count, taken from the referenced node's own resolved count —
   * "this node can never supply more than that one is actually providing,"
   * enforced by Basic/Full mode's `propagateMachineCounts`/
   * `propagateMachineCountsFull` regardless of how much downstream demand
   * this node would otherwise imply. Below the cap (or with no cap at all,
   * or when downstream demand can't be derived at all), this node resolves
   * exactly as it always has; ABOVE it, this node commits to the cap
   * instead and leaves the over-demanding downstream neighbor's own edge
   * looking under-supplied — the ordinary rate-mismatch/shortage machinery
   * (`edgeValidation.ts`/`apps/web`'s `computeInputShortage.ts`) then flags
   * that neighbor exactly like it would for any two ordinary mismatched
   * pinned nodes, no special-casing needed for this field. The referenced
   * node's own resolution is a genuine prerequisite (see `basic.ts`'s
   * doc comment on where this is consulted for exactly why: a fixed-point
   * pass's `resolved` set is permanent, so this node withholds resolving
   * at all until the cap becomes known, rather than resolving off
   * downstream demand and never getting a chance to be capped
   * retroactively) — so a CHAIN of these still propagates correctly, just
   * one extra pass per hop. Ignored entirely by None/Manual mode
   * (`manual.ts`'s own header: "never infers a machine count from the
   * graph" — this field IS an inference, so it stays out).
   *
   * The one current use: `apps/web/src/workers/storagePassthrough.ts`
   * splits a Storage Container into two solver nodes with NO edge between
   * them (deliberately — its input and output don't have to balance), which
   * means neither side's resolved count can otherwise reach the other's at
   * all. The outflow side's `capMachineCountAtNodeId` points at the intake
   * side's node id: a real storage buffer can't emit more per minute than
   * it's actually receiving, no matter what's downstream asking for more —
   * see that module's header for the full writeup, and `basic.ts`'s/
   * `full.ts`'s propagation functions for where this is actually consulted.
   */
  readonly capMachineCountAtNodeId?: string;
}

/**
 * Two-tier priority for Full mode's splitter/merger model (Job 023):
 * `"top"` drains/fills first from the shared pool at a splitter/merger
 * point; `"bottom"` only receives whatever's left over once every
 * `"top"`-tier sibling edge (same owning node + part + direction — see
 * `full.ts`'s `buildSplitGroups`) has taken its share, up to its own
 * capacity. `undefined` (the only value None/Manual/Basic mode ever see) is
 * INFERRED by `full.ts`'s `inferredTier` for any edge that doesn't set it
 * explicitly: an edge whose other endpoint has an explicit `limit` set (a
 * fixed, finite demand/supply) defaults to `"top"`; one whose other endpoint
 * has no limit (open-ended — e.g. an "unlimited" AWESOME Sink/Dimensional
 * Depot, or a node with no resolvable neighbor of its own) defaults to
 * `"bottom"`. This means a limited node's demand is always satisfied first
 * from a shared source, ahead of unlimited siblings, even with no priority
 * metadata set at all — a group where EVERY sibling is limited (or every
 * sibling is unlimited) still behaves as one plain even-split-preferred
 * pool, since every candidate lands in the same tier.
 *
 * This is deliberately a single, direction-agnostic property of the edge
 * itself (not "priority as a splitter output" vs "priority as a merger
 * input" separately) — see jobs/023-full-calculator.md's Handoff notes for
 * the reasoning and its one documented limitation (an edge that is
 * simultaneously a priority-tagged splitter output AND a priority-tagged
 * merger input can't have a different intended tier on each side today).
 *
 * There is still no dedicated "Priority Splurger" node type anywhere in
 * this snapshot (Job 024's job, per this package's Job 017 Handoff notes on
 * what a later job needs to add) — this field is the minimal extension that
 * lets Full mode's solver compute priority-tier routing correctly for ANY
 * node whose multiple same-part edges should be tiered, ahead of that
 * dedicated node type/UI existing.
 */
export type PriorityTier = "top" | "bottom";

export interface SolverEdge {
  readonly id: string;
  /** The `@scm/gamedata` `Part.name` this connection carries. */
  readonly part: string;
  readonly fromNode: string;
  readonly fromPort: string;
  readonly toNode: string;
  readonly toPort: string;
  /**
   * Full mode only (Job 023) — see `PriorityTier`'s own doc comment.
   * Ignored entirely by None/Manual/Basic mode (they have no splitter
   * priority concept at all).
   */
  readonly priorityTier?: PriorityTier;
}

export interface SolverSnapshot {
  readonly nodes: readonly SolverNode[];
  readonly edges: readonly SolverEdge[];
}
