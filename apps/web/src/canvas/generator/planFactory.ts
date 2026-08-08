// "Generate Factory" — builds a full production chain automatically from a
// single (target item, desired items/minute) input, expanding backward
// through `@scm/gamedata`'s recipe graph the same way a player would plan
// one by hand: pick a producing recipe for the target, figure out how many
// machines that takes, then repeat for every input it needs.
//
// Deliberately free of React/Yjs/DOM (same convention as
// `recipeChooser/filters.ts`) so the graph math is unit-testable with plain
// vitest — `applyFactoryPlan.ts` is the thin layer that actually writes a
// `FactoryPlan` into a live `SfmDocument`.
import type { GameData, Recipe } from "@scm/gamedata";
import { ZERO, abs, add, divide, isNegative, isZero, multiply, type Rational } from "@scm/rational";
import type { Purity } from "@scm/ydoc";

import { buildNodeInputForRecipe, sortRecipesForChooser } from "../../panels/recipeChooser/filters";
import { ratePerMachineAtFullClock, type MachineRef } from "../nodes";

export interface PlannedNode {
  /** The part this node was chosen to produce — also its unique key within a `FactoryPlan` (see this module's header for why it's one node per PART, not per recipe). */
  part: string;
  recipe: Recipe;
  machine: string;
  purity: Purity | null;
  /** Exact machine count (at 100% clock) needed to hit this part's total demand. */
  machineCount: Rational;
  /** Total required rate of `part`, aggregated across every downstream consumer (and the target rate itself, for the root). */
  demand: Rational;
  /** Topological distance from raw materials (0 = a recipe with no inputs, e.g. ore extraction) — drives left-to-right column layout. */
  generation: number;
}

export interface PlannedEdge {
  /** Which part flows across this connection. */
  part: string;
  /** The producing node's `PlannedNode.part` key. */
  fromPart: string;
  /** The consuming node's `PlannedNode.part` key. */
  toPart: string;
}

export interface FactoryPlan {
  targetPart: string;
  targetRate: Rational;
  /** One entry per resolved part, ordered so every node appears after every part that depends on it (root/target first) — safe to create in this order, though `applyFactoryPlan` doesn't actually require it. */
  nodes: PlannedNode[];
  edges: PlannedEdge[];
  /** Parts that came up as a required input but have no producing recipe in `@scm/gamedata` at all — left as unconnected input ports on whatever node needed them. */
  unresolvedParts: string[];
}

interface DiscoveredRecipe {
  recipe: Recipe;
  ref: MachineRef;
  inputs: readonly { part: string; perMachineRate: Rational }[];
  /** `ratePerMachineAtFullClock` for the specific part this recipe was chosen to produce — the anchor `machineCount` is solved against. */
  ratePerMachine: Rational;
}

/**
 * Expands the bill of materials for `targetPart` at `targetRate` items/min.
 *
 * Phase 1 (discovery): BFS from `targetPart`, picking one producing recipe
 * per part via `sortRecipesForChooser`'s existing "cheapest recipe first"
 * ordering (cost-depth, then standard-over-alternate, then tier) — the same
 * ranking the Recipe Chooser's own list already uses. That ordering is
 * acyclic by construction (a recipe's cost is strictly `1 + max(input
 * costs)`), which is what guarantees Phase 2 below always terminates.
 *
 * Phase 2 (demand propagation): a Kahn's-algorithm topological pass, root
 * first — each part's `machineCount` is only computed once every downstream
 * consumer that needs it has already contributed its share of demand, so a
 * part needed by two different recipes gets exactly one producer node sized
 * for their combined total, not two independent (and wrong) ones.
 *
 * One node per PART, not per recipe: a multi-output recipe independently
 * selected as the best producer for two different demanded parts (rare —
 * most byproduct recipes aren't anyone's single cheapest route to either of
 * their outputs) ends up as two separate planned nodes rather than one
 * shared machine. Accepted for this generator's scope — PLAN.md's own
 * framing of this tool as a visual calculator, not a fully automatic BOM
 * optimizer; a user can merge duplicate machines by hand afterward.
 */
export function planFactory(gameData: GameData, targetPart: string, targetRate: Rational): FactoryPlan {
  const discovered = new Map<string, DiscoveredRecipe>();
  const consumerCount = new Map<string, number>();
  const visited = new Set<string>([targetPart]);
  const queue: string[] = [targetPart];
  const unresolvedParts: string[] = [];

  while (queue.length > 0) {
    const part = queue.shift()!;
    const candidates = gameData.recipesByPartAsOutput.get(part) ?? [];
    if (candidates.length === 0) {
      unresolvedParts.push(part);
      continue;
    }
    const recipe = sortRecipesForChooser(gameData, candidates)[0]!;
    // Reuses the Recipe Chooser's own machine/purity resolution (plain
    // machine vs. MultiMachine default variant) — `containerId`/`position`
    // are irrelevant here, only `.machine`/`.purity` are read.
    const built = buildNodeInputForRecipe({ gameData, recipe, containerId: "", position: { x: 0, y: 0 } });
    const ref: MachineRef = { machine: built.machine, purity: built.purity };

    const inputs: { part: string; perMachineRate: Rational }[] = [];
    for (const p of recipe.parts) {
      if (!isNegative(p.amount)) continue;
      const rate = abs(ratePerMachineAtFullClock(gameData, recipe, ref, p.part));
      inputs.push({ part: p.part, perMachineRate: rate });
      consumerCount.set(p.part, (consumerCount.get(p.part) ?? 0) + 1);
      if (!visited.has(p.part)) {
        visited.add(p.part);
        queue.push(p.part);
      }
    }

    discovered.set(part, {
      recipe,
      ref,
      inputs,
      ratePerMachine: ratePerMachineAtFullClock(gameData, recipe, ref, part),
    });
  }

  // Phase 2: topological demand propagation, root (target) first.
  const demand = new Map<string, Rational>([[targetPart, targetRate]]);
  const pending = new Map(consumerCount);
  const machineCountByPart = new Map<string, Rational>();
  const order: string[] = [];
  const ready: string[] = [targetPart];
  const finalized = new Set<string>();

  while (ready.length > 0) {
    const part = ready.shift()!;
    if (finalized.has(part)) continue;
    finalized.add(part);
    order.push(part);

    const info = discovered.get(part);
    if (!info) continue; // unresolved leaf — no recipe, nothing to propagate further

    const totalDemand = demand.get(part) ?? ZERO;
    const machineCount = isZero(info.ratePerMachine) ? ZERO : divide(totalDemand, info.ratePerMachine);
    machineCountByPart.set(part, machineCount);

    for (const { part: inputPart, perMachineRate } of info.inputs) {
      const consumed = multiply(machineCount, perMachineRate);
      demand.set(inputPart, add(demand.get(inputPart) ?? ZERO, consumed));
      const remaining = (pending.get(inputPart) ?? 1) - 1;
      pending.set(inputPart, remaining);
      if (remaining <= 0) ready.push(inputPart);
    }
  }

  // Cycle-safety net: force-finalize anything discovery reached that the
  // topological pass never got to (shouldn't trigger — see this function's
  // header — but a silently dropped node would be worse than a
  // partial-demand one).
  for (const part of discovered.keys()) {
    if (finalized.has(part)) continue;
    finalized.add(part);
    order.push(part);
    const info = discovered.get(part)!;
    const totalDemand = demand.get(part) ?? ZERO;
    machineCountByPart.set(part, isZero(info.ratePerMachine) ? ZERO : divide(totalDemand, info.ratePerMachine));
  }

  // Generation = distance from raw materials, computed in the REVERSE of
  // `order` (which is root/target-first): reversing a valid topological
  // order of "consumer needs producer" flips it into a valid topological
  // order of "producer feeds consumer", i.e. raw materials first — exactly
  // what's needed so every input's generation is already known by the time
  // its consumer is reached.
  const generationByPart = new Map<string, number>();
  for (const part of [...order].reverse()) {
    const info = discovered.get(part);
    if (!info || info.inputs.length === 0) {
      generationByPart.set(part, 0);
      continue;
    }
    let generation = 0;
    for (const { part: inputPart } of info.inputs) {
      generation = Math.max(generation, (generationByPart.get(inputPart) ?? 0) + 1);
    }
    generationByPart.set(part, generation);
  }

  const nodes: PlannedNode[] = [];
  const edges: PlannedEdge[] = [];
  for (const part of order) {
    const info = discovered.get(part);
    if (!info) continue;
    nodes.push({
      part,
      recipe: info.recipe,
      machine: info.ref.machine,
      purity: info.ref.purity,
      machineCount: machineCountByPart.get(part) ?? ZERO,
      demand: demand.get(part) ?? ZERO,
      generation: generationByPart.get(part) ?? 0,
    });
    for (const { part: inputPart } of info.inputs) {
      if (!discovered.has(inputPart)) continue; // no producer planned — leave the port unconnected
      edges.push({ part: inputPart, fromPart: inputPart, toPart: part });
    }
  }

  return { targetPart, targetRate, nodes, edges, unresolvedParts };
}

// ---------------------------------------------------------------------------
// Layout — a simple layered/columnar placement (generation -> x column,
// stacked vertically within a column). No auto-layout dependency exists in
// this repo yet (dagre/elkjs etc.) — this is a small hand-rolled one that's
// enough to guarantee non-overlapping nodes for a BOM tree/DAG shape.
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Horizontal spacing between generations. Default comfortably clears a `RecipeNode` card's fixed 256px width. */
  columnWidth?: number;
  /** Vertical gap between stacked nodes within the same column. */
  rowGap?: number;
  /** Top-left anchor for the whole generated layout — typically just clear of whatever's already on the canvas. */
  basePosition?: { x: number; y: number };
}

const DEFAULT_COLUMN_WIDTH = 340;
const DEFAULT_ROW_GAP = 32;
const HEADER_HEIGHT = 40;
const PART_ROW_HEIGHT = 26;
const FOOTER_HEIGHT = 56;

/** Rough card height for a recipe with this many parts — `RecipeNode.tsx`'s real layout is one row per part plus a fixed header/footer; exact to the pixel doesn't matter, just enough to keep a column's nodes from visually overlapping. */
function estimateNodeHeight(recipe: Recipe): number {
  return HEADER_HEIGHT + Math.max(recipe.parts.length, 1) * PART_ROW_HEIGHT + FOOTER_HEIGHT;
}

/** `PlannedNode.part` -> its canvas position. Raw materials (generation 0) land at the left, `plan.targetPart` at the far right — matching every recipe node's own input-left/output-right port layout. */
export function layoutFactoryPlan(plan: FactoryPlan, options: LayoutOptions = {}): Map<string, { x: number; y: number }> {
  const columnWidth = options.columnWidth ?? DEFAULT_COLUMN_WIDTH;
  const rowGap = options.rowGap ?? DEFAULT_ROW_GAP;
  const base = options.basePosition ?? { x: 0, y: 0 };

  const byGeneration = new Map<number, PlannedNode[]>();
  for (const node of plan.nodes) {
    const column = byGeneration.get(node.generation) ?? [];
    column.push(node);
    byGeneration.set(node.generation, column);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [generation, columnNodes] of byGeneration) {
    // Deterministic stacking order — doesn't affect correctness, just keeps
    // repeated generations of the same plan laying out identically.
    const sorted = [...columnNodes].sort((a, b) => a.part.localeCompare(b.part));
    let y = base.y;
    for (const node of sorted) {
      positions.set(node.part, { x: base.x + generation * columnWidth, y });
      y += estimateNodeHeight(node.recipe) + rowGap;
    }
  }
  return positions;
}
