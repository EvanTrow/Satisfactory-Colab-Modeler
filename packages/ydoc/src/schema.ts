// Zod schemas + inferred types for the CRDT document shape defined in
// PLAN.md §4 "The CRDT document schema". This is the single canonical
// description of what lives inside each `Y.Map` — every other module in this
// package (and, transitively, every consumer in `apps/web`/`apps/realtime`)
// treats these types as the source of truth instead of hand-rolling field
// lists. See PLAN.md §7: "packages/ydoc is the only place that knows the
// CRDT shape."
//
// A note on `limit`/`clock`/`beltTier`/`storageMode` and similar fields:
// PLAN.md §4 names these fields but does not pin their on-the-wire type
// beyond what the name implies. Per jobs/007-ydoc-schema.md, deciding
// whether `limit`/`clock` store canonical rational strings (matching the
// Postgres `limit_exact`/`clock_exact` projection columns) or something else
// is deliberately deferred to Job 010 (recipe node UI). This module types
// them as `string` — the same representation `game_data.json` and the
// Postgres exact-value columns already use for lossless numeric values — so
// Job 010 can choose to store canonical `n/d`/decimal strings without a
// schema change. Treat this as a placeholder convention, not a locked-in
// decision.
import { z } from "zod";

/** Bumped whenever the shape in this file changes in a way old docs can't read as-is. */
export const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export const MetaSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  title: z.string(),
  gameDataVersion: z.string(),
});
export type Meta = z.infer<typeof MetaSchema>;

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export const SolverModeSchema = z.enum(["none", "manual", "basic", "full"]);
export type SolverMode = z.infer<typeof SolverModeSchema>;

export const ConnectionStyleSchema = z.enum(["straight", "step", "bezier"]);
export type ConnectionStyle = z.infer<typeof ConnectionStyleSchema>;

export const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Point = z.infer<typeof PointSchema>;

export const NumberFormatStyleSchema = z.enum(["fraction", "mixed", "decimal"]);
export const RoundingModeSchema = z.enum(["round", "floor", "ceil", "truncate"]);

/**
 * Mirrors `@scm/rational`'s `formatRational` options (job 002's Handoff
 * notes) since that package is explicitly "the engine behind the
 * number-format settings feature." `packages/ydoc` does not depend on
 * `@scm/rational` (not needed for this job), so the shape is duplicated
 * here rather than imported — Job 019 (summary panel & formats) is the
 * natural place to reconcile the two if they drift.
 */
export const NumberFormatsSchema = z.object({
  style: NumberFormatStyleSchema,
  digits: z.number().int().nonnegative(),
  rounding: RoundingModeSchema,
  trimTrailingZeros: z.boolean(),
});
export type NumberFormats = z.infer<typeof NumberFormatsSchema>;

export const SettingsSchema = z.object({
  solverMode: SolverModeSchema,
  inputMultiplier: z.number(),
  powerMultiplier: z.number(),
  spaceElevatorMultiplier: z.number(),
  snapMachines: z.boolean(),
  gridMachine: PointSchema,
  snapWaypoints: z.boolean(),
  gridWaypoint: PointSchema,
  numberFormats: NumberFormatsSchema,
  connectionStyle: ConnectionStyleSchema,
  // Progression filters for the Recipe Chooser search. `null` = unset, i.e.
  // no filtering by that axis. `tier` is the game's Tier 0-9; `phase` is the
  // Space Elevator ("Project Assembly") delivery phase 1-5 — see
  // `apps/web/src/panels/recipeChooser/progression.ts` for the real
  // phase-unlocks-which-tiers table and the cross-field validation that
  // keeps these two from landing on a combination no real save could reach.
  // Both are cumulative ("available by this point") when set, and AND
  // together when both are set.
  recipeTierFilter: z.number().int().min(0).max(9).nullable(),
  recipePhaseFilter: z.number().int().min(1).max(5).nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------------------
// containers
// ---------------------------------------------------------------------------

export const ContainerKindSchema = z.enum(["root", "outpost"]);
export type ContainerKind = z.infer<typeof ContainerKindSchema>;

export const ContainerSchema = z.object({
  id: z.string(),
  kind: ContainerKindSchema,
  // null for the root container; every other container's parent chain
  // terminates at root.
  parentId: z.string().nullable(),
  title: z.string(),
  color: z.string(),
  x: z.number(),
  y: z.number(),
});
export type Container = z.infer<typeof ContainerSchema>;

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

/**
 * Known node kinds as of Phase 2/4/6 of PLAN.md's roadmap (recipe nodes land
 * in Job 010; splitter/storage/outpost-reference/priority kinds land later).
 * Kept as an open string type (`(string & {})` union member) rather than a
 * closed enum because PLAN.md §4's own Postgres projection comment lists
 * `'recipe' | 'splurger' | 'storage' | 'outpost' | ...` with an explicit
 * ellipsis — more kinds are expected to be added by later jobs without
 * requiring a schema change here.
 */
export const KNOWN_NODE_KINDS = [
  "recipe",
  "splitter",
  "merger",
  "storage",
  "sink",
  "depot",
  "outpost",
  "outpost-input",
  "outpost-output",
] as const;
export type KnownNodeKind = (typeof KNOWN_NODE_KINDS)[number];
export type NodeKind = KnownNodeKind | (string & {});

/**
 * `NodeRecord.storageMode`'s four documented values (PLAN.md §2's "Storage
 * Container (four modes: Partially Full / Full / Empty / Input = Output)").
 * Documentation/UI convenience only — the wire type stays the existing open
 * `string | null` (no schema version bump); `apps/web`'s Storage Container
 * card is the only consumer, and only `"partiallyFull"` has real solver
 * behavior as of this addition (see `apps/web/src/canvas/nodes/StorageNode.tsx`).
 */
export const STORAGE_MODES = ["partiallyFull", "full", "empty", "inputEqualsOutput"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

export const LimitModeSchema = z.enum(["machines", "ppm"]);
export type LimitMode = z.infer<typeof LimitModeSchema>;

export const PuritySchema = z.enum(["impure", "normal", "pure"]);
export type Purity = z.infer<typeof PuritySchema>;

/**
 * Which of the 3 Splitter buildables a `kind: "splitter"` node models — a
 * splitter always has 1 input / 3 outputs (real Conveyor/Smart/Programmable
 * Splitter hardware never has a different port count); the variant only
 * changes whether the 3 output ports carry per-port routing rules.
 * `"basic"` (Conveyor Splitter): no rules, every output is plain "Any".
 * `"smart"`/`"programmable"`: each output slot has an independently
 * configured rule, decoded from `NodeRecord.priorityOrder` — see
 * `apps/web/src/workers/splitMergePassthrough.ts`'s `decodeSplitterConfig`.
 * `null` means "not a splitter kind at all" (this field is only ever read
 * for `kind: "splitter"` nodes).
 */
export const SplitterVariantSchema = z.enum(["basic", "smart", "programmable"]);
export type SplitterVariant = z.infer<typeof SplitterVariantSchema>;

/**
 * Which of the 2 Merger buildables a `kind: "merger"` node models — a
 * merger always has 3 inputs / 1 output. `"basic"` (Conveyor Merger): no
 * priority, every input shares one fair pool. `"priority"` (Priority
 * Merger): each input slot has an independently configured Low/Medium/High
 * priority, decoded from `NodeRecord.priorityOrder` — see
 * `apps/web/src/workers/splitMergePassthrough.ts`'s `decodeMergerConfig`.
 * `null` means "not a merger kind at all".
 */
export const MergerVariantSchema = z.enum(["basic", "priority"]);
export type MergerVariant = z.infer<typeof MergerVariantSchema>;

export const NodeRecordSchema = z.object({
  id: z.string(),
  containerId: z.string(),
  kind: z.string(),
  // Recipe/machine references are plain strings keyed to `game_data.json`
  // names — @scm/gamedata resolves/validates them, this package doesn't.
  recipe: z.string().nullable(),
  machine: z.string().nullable(),
  x: z.number(),
  y: z.number(),
  title: z.string(),
  color: z.string(),
  // See the module-level note: on-the-wire type deliberately left as
  // `string`, semantics owned by Job 010.
  limit: z.string().nullable(),
  limitMode: LimitModeSchema,
  clock: z.string().nullable(),
  autoRound: z.boolean(),
  shards: z.number().int().nonnegative(),
  purity: PuritySchema.nullable(),
  beltTier: z.string().nullable(),
  storageMode: z.string().nullable(),
  splitterVariant: SplitterVariantSchema.nullable(),
  mergerVariant: MergerVariantSchema.nullable(),
  // Y.Array<portId> at the Yjs layer; a plain string[] once read out. Reused
  // per node kind: recipe node row display order (`RecipeNode.tsx`), or —
  // for `kind: "splitter"`/`"merger"` — per-slot port configuration (see
  // `SplitterVariantSchema`/`MergerVariantSchema`'s own doc comments above).
  priorityOrder: z.array(z.string()),
});
export type NodeRecord = z.infer<typeof NodeRecordSchema>;

// ---------------------------------------------------------------------------
// edges
// ---------------------------------------------------------------------------

export const WaypointSchema = PointSchema;
export type Waypoint = z.infer<typeof WaypointSchema>;

export const EdgeRecordSchema = z.object({
  id: z.string(),
  containerId: z.string(),
  // Which item/fluid this connection carries.
  part: z.string(),
  fromNode: z.string(),
  fromPort: z.string(),
  toNode: z.string(),
  toPort: z.string(),
  waypoints: z.array(WaypointSchema),
  style: z.string().nullable(),
  // Position of the edge's label along its path, 0..1. See jobs/011 for the
  // UI that actually drags this.
  labelPos: z.number().nullable(),
});
export type EdgeRecord = z.infer<typeof EdgeRecordSchema>;
