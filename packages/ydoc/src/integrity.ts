// The integrity reducer — PLAN.md §5's "Integrity reducer" (Job 022, the
// payoff of the `origin: 'integrity'` hook Job 007 reserved in `undo.ts`).
//
// A CRDT guarantees convergence, not correctness: two clients always reach
// the same state, but that state can violate this app's own invariants —
// user A deletes a machine while user B connects an edge to it; user A
// deletes an outpost while user B has a node inside it; user A changes a
// node's recipe while user B is wired to a port that no longer exists on
// the new recipe. This module is the repair pass that runs after such a
// merge and fixes the document back into a state every other part of the
// app (the solver, the canvas renderer, the Postgres projection) can rely
// on, per PLAN.md §5's four bullets, plus one later addition (rule 5 below):
//
//   1. Delete edges whose fromNode/toNode no longer exists.
//   2. Reparent orphaned nodes (and, generalized here, orphaned containers
//      and orphaned edges) to the root container rather than deleting them.
//   3. Clamp shards to the current machine's MaxProductionShards; drop
//      ports the current recipe doesn't have.
//   4. Deduplicate edges (a backstop given Job 007's deterministic edgeId).
//   5. Normalize resource-extraction nodes (Miner/Water Extractor/Oil
//      Extractor/Resource Well Extractor) to their flat default variant and
//      `"ppm"` limit mode — not a merge-corruption repair like 1-4, but the
//      same mechanism doubles as a one-time migration for projects created
//      before these four lost their Mk./purity picker and machine-count
//      option (see `normalizeResourceExtractorVariant`'s own comment
//      below).
//
// Callers MUST run this inside a transaction tagged `origin: 'integrity'`
// (see `undo.ts`'s `runAsIntegrity`) so the repair never lands on anyone's
// undo stack — `runIntegrityReducer` below does this for you.
//
// Reused, not duplicated: rule 2's "reparent rather than destroy" principle
// is exactly what `apps/web/src/canvas/outposts/reparent.ts`'s
// `deleteOutpost` already implements for a single user's own explicit
// outpost-delete action (Job 013). This module generalizes that same
// reparent-to-parent shape into "reparent to root, triggered by ANY
// transaction that leaves a containerId/parentId dangling, from any cause"
// — the concurrent-edit case `deleteOutpost` alone can't cover, since it
// only ever fires from that one user's own local UI action.
import {
  RESOURCE_EXTRACTOR_RECIPE_MACHINES,
  baseRecipeRatePerMinuteForEntry,
  defaultGameData,
  defaultVariant,
  multiMachineRecipeRatePerMinuteForEntry,
  resolveMachine,
  type GameData,
  type Recipe,
} from "@scm/gamedata";
import { abs, isNegative, isZero, multiply, parseRational, toFractionString, type Rational } from "@scm/rational";

import type { SfmDocument } from "./document.js";
import { listContainers, listEdges, listNodes } from "./document.js";
import { removeEdge, reparentEdge, updateContainer, updateNode } from "./mutations.js";
import { runAsIntegrity } from "./undo.js";
import type { EdgeRecord, LimitMode, Purity } from "./schema.js";

/** A per-rule count of what `runIntegrityReducer` actually changed, for tests/logging. All-zero means the document was already clean. */
export interface IntegrityRepairSummary {
  /** Containers whose dangling `parentId` was reset to point at root. */
  reparentedContainerIds: string[];
  /** Nodes whose dangling `containerId` was reset to point at root. */
  reparentedNodeIds: string[];
  /** Edges whose dangling `containerId` was reset to point at root (the edge itself is kept — only its container changed). */
  reparentedEdgeContainerIds: string[];
  /** Edges deleted because `fromNode` and/or `toNode` no longer exists. */
  deletedDanglingEdgeIds: string[];
  /** Edges deleted because they were wired to a port the node's current recipe doesn't have. */
  deletedInvalidPortEdgeIds: string[];
  /** Nodes whose `shards` was clamped down to the machine's `MaxProductionShards`. */
  clampedShardNodeIds: string[];
  /** Edges deleted as an exact-duplicate-connection backstop (see this module's header comment on rule 4). */
  deletedDuplicateEdgeIds: string[];
  /** Resource-extraction nodes whose `machine`/`purity`/`limitMode`/`limit` was normalized to the flat default variant and `"ppm"` mode (see rule 5). */
  normalizedResourceExtractorNodeIds: string[];
}

function emptySummary(): IntegrityRepairSummary {
  return {
    reparentedContainerIds: [],
    reparentedNodeIds: [],
    reparentedEdgeContainerIds: [],
    deletedDanglingEdgeIds: [],
    deletedInvalidPortEdgeIds: [],
    clampedShardNodeIds: [],
    deletedDuplicateEdgeIds: [],
    normalizedResourceExtractorNodeIds: [],
  };
}

function findRootContainerId(sfmDoc: SfmDocument): string | null {
  const root = listContainers(sfmDoc).find((container) => container.kind === "root" && container.parentId === null);
  return root?.id ?? null;
}

/**
 * The port handle-id convention Job 011 established
 * (`apps/web/src/canvas/nodes/RecipeNode.tsx`'s `PartRow`):
 * `${"in"|"out"}:${part name}`, direction matching `RecipePart.amount`'s
 * sign. Duplicated here (rather than imported from `apps/web`, which
 * `packages/ydoc` must never depend on — PLAN.md §7's dependency direction
 * is the other way around) since it's a tiny, stable, cross-cutting
 * convention both sides need to agree on byte-for-byte for rule 3 to work.
 */
function recipePortId(part: string, amount: { numerator: bigint; denominator: bigint }): string {
  return `${isNegative(amount) ? "in" : "out"}:${part}`;
}

/** Rule 2: reparent any non-root container whose `parentId` no longer exists to root. */
function reparentOrphanedContainers(
  sfmDoc: SfmDocument,
  rootId: string,
  summary: IntegrityRepairSummary,
): void {
  const containers = listContainers(sfmDoc);
  const containerIds = new Set(containers.map((c) => c.id));
  for (const container of containers) {
    if (container.id === rootId) continue;
    if (container.parentId === null || !containerIds.has(container.parentId)) {
      updateContainer(sfmDoc, container.id, { parentId: rootId });
      summary.reparentedContainerIds.push(container.id);
    }
  }
}

/** Rule 2: reparent any node whose `containerId` no longer exists to root. */
function reparentOrphanedNodes(sfmDoc: SfmDocument, rootId: string, summary: IntegrityRepairSummary): void {
  const containerIds = new Set(listContainers(sfmDoc).map((c) => c.id));
  for (const node of listNodes(sfmDoc)) {
    if (!containerIds.has(node.containerId)) {
      updateNode(sfmDoc, node.id, { containerId: rootId });
      summary.reparentedNodeIds.push(node.id);
    }
  }
}

/** Rule 2 (generalized): reparent any edge whose `containerId` no longer exists to root — the edge itself is kept, only its display container changes, mirroring `reparentEdge`'s existing use in `deleteOutpost`. */
function reparentOrphanedEdgeContainers(
  sfmDoc: SfmDocument,
  rootId: string,
  summary: IntegrityRepairSummary,
): void {
  const containerIds = new Set(listContainers(sfmDoc).map((c) => c.id));
  for (const edge of listEdges(sfmDoc)) {
    if (!containerIds.has(edge.containerId)) {
      reparentEdge(sfmDoc, edge.id, rootId);
      summary.reparentedEdgeContainerIds.push(edge.id);
    }
  }
}

/** Rule 1: delete any edge whose `fromNode` or `toNode` no longer exists. */
function deleteDanglingEdges(sfmDoc: SfmDocument, summary: IntegrityRepairSummary): void {
  const nodeIds = new Set(listNodes(sfmDoc).map((n) => n.id));
  for (const edge of listEdges(sfmDoc)) {
    if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) {
      removeEdge(sfmDoc, edge.id);
      summary.deletedDanglingEdgeIds.push(edge.id);
    }
  }
}

/**
 * Rule 3: clamp every node's `shards` to its resolved machine's
 * `MaxProductionShards` (0 if the machine can't be resolved or doesn't
 * support shards at all), and delete any edge wired to a port the node's
 * *current* `recipe` doesn't have. A node whose `recipe`/`machine` string
 * doesn't resolve against `gameData` at all (e.g. a stale reference from a
 * `game_data.json` version bump — PLAN.md §10's open question) is left
 * alone here: there's no valid port set to compare against, and deleting
 * every incident edge on "unknown recipe" would be a much more aggressive,
 * unrelated repair than this rule is meant to make.
 */
function clampShardsAndDropInvalidPorts(
  sfmDoc: SfmDocument,
  gameData: GameData,
  summary: IntegrityRepairSummary,
): void {
  for (const node of listNodes(sfmDoc)) {
    const machine = node.machine ? gameData.machinesByName.get(node.machine) : undefined;
    if (machine) {
      const maxShards = machine.maxProductionShards ?? 0;
      if (node.shards > maxShards || node.shards < 0) {
        updateNode(sfmDoc, node.id, { shards: Math.max(0, Math.min(node.shards, maxShards)) });
        summary.clampedShardNodeIds.push(node.id);
      }
    }

    const recipe = node.recipe ? gameData.recipesByName.get(node.recipe) : undefined;
    if (!recipe) continue;

    const validPorts = new Set(recipe.parts.map((part) => recipePortId(part.part, part.amount)));
    for (const edge of listEdges(sfmDoc)) {
      const touchesInvalidPort =
        (edge.fromNode === node.id && !validPorts.has(edge.fromPort)) ||
        (edge.toNode === node.id && !validPorts.has(edge.toPort));
      if (touchesInvalidPort) {
        removeEdge(sfmDoc, edge.id);
        summary.deletedInvalidPortEdgeIds.push(edge.id);
      }
    }
  }
}

/**
 * Rule 4 (backstop): Job 007's deterministic `edgeId` means two concurrent
 * `addEdge` calls for the same `(fromNode, fromPort, toNode, toPort)` tuple
 * already converge to one Yjs map entry for free — this can only ever find
 * something to do if a document was corrupted some other way (a
 * non-conforming client writing two different top-level keys for the same
 * logical connection). Keeps the lexicographically-smaller `id` so the
 * choice is itself deterministic across every replica running this same
 * reducer independently — required for the fuzz test's byte-identical
 * convergence assertion.
 */
function dedupeEdges(sfmDoc: SfmDocument, summary: IntegrityRepairSummary): void {
  const keepByKey = new Map<string, EdgeRecord>();
  for (const edge of listEdges(sfmDoc)) {
    const key = `${edge.fromNode} ${edge.fromPort} ${edge.toNode} ${edge.toPort}`;
    const existing = keepByKey.get(key);
    if (!existing) {
      keepByKey.set(key, edge);
      continue;
    }
    const [keep, drop] = existing.id < edge.id ? [existing, edge] : [edge, existing];
    keepByKey.set(key, keep);
    if (sfmDoc.edges.has(drop.id)) {
      removeEdge(sfmDoc, drop.id);
      summary.deletedDuplicateEdgeIds.push(drop.id);
    }
  }
}

/**
 * The reference rate `node`'s CURRENT (pre-migration) `machine`/`purity`
 * produces at 100% clock — used only to convert an old machine-count
 * `limit` into an equivalent ppm value below, so a "3 machines at Pure"
 * node converts to the rate 3 Pure machines actually produced (720/min),
 * not 3x whatever the NEW default variant (Normal) would produce (360/min).
 * Mirrors `resolveMachine`+match-by-name-then-purity exactly the way
 * `nodeProfile.ts`'s `resolveNodeMachine`/`recipeNodeMath.ts`'s
 * `resolvedVariantFor` already do (duplicated here rather than imported —
 * both of those live in packages this one must never depend on). Every
 * resource-extraction recipe has exactly one part, so `recipe.parts[0]`
 * unambiguously IS its primary part — unlike those two files' own
 * general-purpose `primaryPart` helpers, which have to pick the
 * largest-magnitude part out of an arbitrary recipe. `undefined` only if
 * `recipe` genuinely has no parts (shouldn't happen for any real
 * resource-extraction recipe) or its MultiMachine family has no variants at
 * all (malformed game data).
 */
function referenceRateForNode(
  gameData: GameData,
  recipe: Recipe,
  node: { machine: string | null; purity: Purity | null },
): Rational | undefined {
  const part = recipe.parts[0];
  if (!part) return undefined;
  const resolved = resolveMachine(recipe.machine, gameData);
  if (resolved.kind === "machine") {
    return baseRecipeRatePerMinuteForEntry(recipe, part);
  }
  const matches = resolved.variants.filter((v) => v.machine.name === node.machine);
  const byPurity = matches.length > 1 ? matches.find((v) => v.capacity?.name.toLowerCase() === node.purity) : undefined;
  const variant = byPurity ?? matches[0] ?? defaultVariant(resolved);
  if (!variant) return undefined;
  return multiMachineRecipeRatePerMinuteForEntry(recipe, part, variant);
}

/**
 * Rule 5: normalize every resource-extraction node (`@scm/gamedata`'s
 * `RESOURCE_EXTRACTOR_RECIPE_MACHINES` — Miner, Water Extractor, Oil
 * Extractor, Resource Well Extractor) back to its flat default variant and
 * `"ppm"` limit mode. Unlike rules 1-4 above, this isn't repairing
 * CRDT-merge corruption — it's a deliberate product-behavior change:
 * `RecipeChooser.tsx` no longer offers a Mk./purity picker for any of the
 * four, and none of them can be switched to machine-count mode any more, so
 * no *new* node can end up with a non-default variant or the wrong mode.
 * This rule exists so projects created before that change normalize the
 * moment they're next loaded or edited, using the same transaction/
 * undo-exclusion machinery (and the same client+server call sites) as the
 * rest of this module — generalizing what was originally a Miner-only rule.
 *
 * `machine`/`purity` are reset straight to the default variant (only
 * meaningful for the three MultiMachine-backed families — Water Extractor
 * has no variant to normalize, `purity` is already always `null` for it).
 * `limitMode`, when not already `"ppm"`, is flipped to `"ppm"`; a non-null
 * `limit` in that case is a real machine count the user already typed, so
 * it's CONVERTED to the equivalent ppm value (old count x the default
 * variant's own reference rate) rather than discarded outright — the same
 * "a value the user already typed is deliberate, preserve its MEANING"
 * principle the original Miner-only rule's untouched-`limit` behavior
 * established, just applied across a mode conversion instead of a variant
 * change. Falls back to blank (`limit: null` — the solver's own "derive it"
 * state, see `nodeProfile.ts`'s `resourceExtractorSoftDefault`) only when
 * that conversion genuinely can't be computed (a corrupt `limit` string, or
 * no resolvable reference rate).
 */
function normalizeResourceExtractorVariant(
  sfmDoc: SfmDocument,
  gameData: GameData,
  summary: IntegrityRepairSummary,
): void {
  for (const node of listNodes(sfmDoc)) {
    const recipe = node.recipe ? gameData.recipesByName.get(node.recipe) : undefined;
    if (!recipe || !RESOURCE_EXTRACTOR_RECIPE_MACHINES.has(recipe.machine)) continue;

    const patch: { machine?: string; purity?: Purity | null; limitMode?: LimitMode; limit?: string | null } = {};

    const resolved = resolveMachine(recipe.machine, gameData);
    if (resolved.kind === "multiMachine") {
      const variant = defaultVariant(resolved);
      const defaultPurity = (variant?.capacity?.name.toLowerCase() as Purity | undefined) ?? null;
      if (variant && (node.machine !== variant.machine.name || node.purity !== defaultPurity)) {
        patch.machine = variant.machine.name;
        patch.purity = defaultPurity;
      }
    }

    if (node.limitMode !== "ppm") {
      patch.limitMode = "ppm";
      patch.limit = null;
      if (node.limit !== null) {
        try {
          const oldMachineCount = parseRational(node.limit);
          const referenceRate = referenceRateForNode(gameData, recipe, node);
          if (referenceRate && !isZero(referenceRate)) {
            patch.limit = toFractionString(multiply(oldMachineCount, abs(referenceRate)));
          }
        } catch {
          // Corrupt `limit` string — fall back to the `null` already set above.
        }
      }
    }

    if (Object.keys(patch).length > 0) {
      updateNode(sfmDoc, node.id, patch);
      summary.normalizedResourceExtractorNodeIds.push(node.id);
    }
  }
}

/**
 * Applies every PLAN.md §5 repair rule to `sfmDoc` in place, in a single
 * pass. Pure repair logic — does NOT open its own transaction or tag an
 * origin; call `runIntegrityReducer` (below) unless you're already inside
 * an `origin: 'integrity'` transaction (e.g. batching several docs' repairs
 * together in a test).
 */
export function repairDocument(
  sfmDoc: SfmDocument,
  gameData: GameData = defaultGameData,
): IntegrityRepairSummary {
  const summary = emptySummary();

  const rootId = findRootContainerId(sfmDoc);
  if (rootId !== null) {
    reparentOrphanedContainers(sfmDoc, rootId, summary);
    reparentOrphanedNodes(sfmDoc, rootId, summary);
    reparentOrphanedEdgeContainers(sfmDoc, rootId, summary);
  }
  // No root container at all (a malformed/empty document with no recovery
  // target) — nothing to reparent into, so rules 1/3/4 below still run
  // (they don't need a root), but orphaned containerId/parentId references
  // are left as-is rather than guessing a destination.

  deleteDanglingEdges(sfmDoc, summary);
  clampShardsAndDropInvalidPorts(sfmDoc, gameData, summary);
  normalizeResourceExtractorVariant(sfmDoc, gameData, summary);
  dedupeEdges(sfmDoc, summary);

  return summary;
}

/** True if `summary` represents a no-op pass (nothing needed repairing). */
export function isNoopRepair(summary: IntegrityRepairSummary): boolean {
  return (
    summary.reparentedContainerIds.length === 0 &&
    summary.reparentedNodeIds.length === 0 &&
    summary.reparentedEdgeContainerIds.length === 0 &&
    summary.deletedDanglingEdgeIds.length === 0 &&
    summary.deletedInvalidPortEdgeIds.length === 0 &&
    summary.clampedShardNodeIds.length === 0 &&
    summary.deletedDuplicateEdgeIds.length === 0 &&
    summary.normalizedResourceExtractorNodeIds.length === 0
  );
}

/**
 * Runs `repairDocument` inside a transaction tagged `origin: 'integrity'`
 * (`undo.ts`'s `runAsIntegrity`) — the reserved origin Job 007 configured
 * `createUndoManager` to unconditionally exclude from every undo stack, so
 * this repair never becomes something a user can "undo" back into a corrupt
 * state. This is the function both `apps/web`'s local transaction pipeline
 * and `apps/realtime`'s document lifecycle call — see PLAN.md §5: "run
 * after every transaction, on both client and server."
 */
export function runIntegrityReducer(
  sfmDoc: SfmDocument,
  gameData: GameData = defaultGameData,
): IntegrityRepairSummary {
  let summary!: IntegrityRepairSummary;
  runAsIntegrity(sfmDoc, () => {
    summary = repairDocument(sfmDoc, gameData);
  });
  return summary;
}
