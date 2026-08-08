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
import { compareTiers, type GameData, type Recipe } from "@scm/gamedata";
import {
  ZERO,
  abs,
  add,
  compare,
  divide,
  isNegative,
  isPositive,
  isZero,
  multiply,
  subtract,
  type Rational,
} from "@scm/rational";
import type { Purity } from "@scm/ydoc";

import { buildNodeInputForRecipe, sortRecipesForChooser } from "../../panels/recipeChooser/filters";
import { primaryPart, ratePerMachineAtFullClock, type MachineRef } from "../nodes";
import { createRecipeSelector, type GenerationPriority } from "./recipePriority";

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

/** One desired output item + its target rate — `planFactory` accepts any number of these at once. */
export interface FactoryTarget {
  part: string;
  rate: Rational;
}

/**
 * One byproduct part (a chosen recipe's OWN secondary positive output, not
 * the part it was picked to produce) that isn't already spoken for by a
 * dedicated producer elsewhere in the plan — see `FactoryPlan
 * .byproductDisposals`'s own doc comment for the full policy.
 */
export interface ByproductDisposal {
  part: string;
  /** Every existing plan node (by `PlannedNode.part`) that produces `part` as a byproduct, and how much. */
  sources: readonly { fromPart: string; rate: Rational }[];
  /** Sum of every source's rate. */
  totalRate: Rational;
  /**
   * Set when `part` is ALSO produced by its own dedicated RAW-MATERIAL node
   * elsewhere in the plan (generation 0 — no inputs of its own) with real
   * downstream demand to absorb — see `applyByproductReuse`'s own doc
   * comment for why reducing THAT specific kind of node is the one
   * exception to this feature's no-cascade policy. `rate` is how much of
   * `totalRate` got redirected there instead of counting toward disposal
   * (that node's own `machineCount`, in `FactoryPlan.nodes`, has already
   * been shrunk by exactly this much); `intoParts` are its existing
   * consumers (from `FactoryPlan.edges`) that should ALSO receive a direct
   * edge from every one of `sources`, alongside their existing edge from
   * the now-smaller raw producer.
   */
  reuse?: { rate: Rational; intoParts: readonly string[] };
  /** `totalRate` minus `reuse`'s own `rate` (or just `totalRate` when there's no reuse) — the portion that still needs disposing. Can be zero, meaning reuse alone accounted for the entire byproduct. */
  disposalRate: Rational;
  /**
   * Whether `part` itself, un-converted, is physically valid to route
   * straight into an AWESOME Sink — false for a fluid/gas (`@scm/gamedata`'s
   * `Part.fluid`) that has no `conversion` (every fluid/gas MUST be
   * converted to a solid or packaged first; the game has no "liquid sink").
   * Only consulted when `conversion` is `undefined`: a set `conversion`
   * always has a solid `outputPart`, so ITS output is what actually reaches
   * the sink regardless of `part`'s own state. When both this is `false`
   * AND `conversion` is `undefined`, `disposalRate` is left un-wired rather
   * than routed into an invalid raw-fluid-to-sink edge.
   */
  rawSinkAllowed: boolean;
  /**
   * Set when a recipe exists that consumes `part` outright — a new node
   * should be created to run the byproduct through it, sized to consume
   * `disposalRate` exactly, with ITS OWN primary output (guaranteed solid —
   * see `rawSinkAllowed`) routed to the sink instead of the raw byproduct.
   * `undefined` means no such recipe exists (or none survived
   * `disabledRecipes`/`allowConverters`) — `disposalRate` of the raw
   * byproduct goes straight to the sink instead, if `rawSinkAllowed`.
   */
  conversion?: {
    recipe: Recipe;
    machine: string;
    purity: Purity | null;
    machineCount: Rational;
    outputPart: string;
    outputRate: Rational;
    /**
     * Set when `recipe` needs a SECOND input besides `part` itself — e.g.
     * packaging a fluid/gas always also needs an empty canister/fluid tank
     * (see this module's header for why packaging is the one case allowed
     * to build its own small recursive supply chain, unlike every other
     * disposal conversion, which stays single-input-only). Resolved exactly
     * like an independent `planFactory` call — its own dedicated producers,
     * even duplicating a part that already exists elsewhere in this same
     * plan or another disposal's own support chain, never merged with
     * either, for the same no-cascade reason `byproductDisposals` itself
     * never touches the main demand graph. `part`/`rate` are the second
     * input's own name and required rate; `nodes`/`edges` are its resolved
     * chain (from `PlannedNode`s with `rate` of `part` as their root's
     * demand, down to raw materials).
     */
    supportChain?: {
      part: string;
      rate: Rational;
      nodes: readonly PlannedNode[];
      edges: readonly PlannedEdge[];
    };
  };
}

export interface FactoryPlan {
  targets: readonly FactoryTarget[];
  /** One entry per resolved part, ordered so every node appears after every part that depends on it (every target, then their consumers-before-producers chain) — safe to create in this order, though `applyFactoryPlan` doesn't actually require it. */
  nodes: PlannedNode[];
  edges: PlannedEdge[];
  /** Parts that came up as a required input (or a target itself) but have no producing recipe in `@scm/gamedata` at all — left as unconnected input ports on whatever node needed them. */
  unresolvedParts: string[];
  /**
   * Present only when `options.handleByproducts` is set. Each entry is a
   * byproduct part with something to report — either surplus that still
   * needs disposing (`disposalRate`), or supply that got reused to shrink a
   * raw-material node's own machine count (`reuse`), or both. INCLUDES
   * byproduct parts that are ALSO independently produced by their own
   * dedicated node elsewhere in `nodes` (i.e. `discovered.has(part)`): that
   * dedicated node's `machineCount` is solved purely from Phase 2's demand
   * propagation, which never sees a byproduct's positive output, so the
   * dedicated node always supplies exactly the real downstream demand on
   * its own — every unit of a byproduct sharing that same part is therefore
   * surplus on top, not "already accounted for." This deliberately does NOT
   * reduce that dedicated producer's own machine count to absorb the
   * byproduct instead — UNLESS that dedicated producer is itself a raw
   * material (see `ByproductDisposal.reuse` and `applyByproductReuse`'s own
   * doc comment for why that ONE case is safe: a raw node has no inputs of
   * its own, so shrinking it can't cascade into anything upstream needing
   * re-sizing). Reducing any OTHER kind of dedicated producer would change
   * ITS inputs' demand too, cascading arbitrarily far up the graph — the
   * kind of whole-system rebalancing PLAN.md itself frames this tool as
   * deliberately NOT doing, a visual calculator rather than a fully
   * automatic BOM optimizer. Every entry's `disposalRate` (and a
   * `conversion`'s own `supportChain`, if any) is instead a self-contained,
   * additive side-chain that never touches the main demand graph's own
   * numbers.
   */
  byproductDisposals: ByproductDisposal[];
}

interface DiscoveredRecipe {
  recipe: Recipe;
  ref: MachineRef;
  inputs: readonly { part: string; perMachineRate: Rational }[];
  /** `ratePerMachineAtFullClock` for the specific part this recipe was chosen to produce — the anchor `machineCount` is solved against. */
  ratePerMachine: Rational;
}

/**
 * Expands the combined bill of materials for every entry in `targets` (one
 * or more desired output items, each with its own rate/min). Multiple
 * targets that share intermediates or raw materials converge onto the same
 * producer node, sized for their combined demand — no different from how a
 * single target's demand fans out across multiple consumers (see Phase 2
 * below); a target simply seeds `demand` from outside the graph instead of
 * from another recipe's consumption.
 *
 * Phase 1 (discovery): a DFS from every target part, picking one producing
 * recipe per part via `options.priority`'s ranking (`recipePriority.ts`) —
 * `"balanced"`'s cost-depth ordering happens to be acyclic by construction
 * (a recipe's cost is strictly `1 + max(input costs)`, so it can never
 * prefer a recipe whose inputs loop back to something already being
 * resolved), but the other, RATE-weighted priorities have no such
 * guarantee: two alternates can each legitimately look cheapest for their
 * own part once the OTHER's weight is known, even though picking both
 * simultaneously forms a cycle (the canonical real example is Recycled
 * Plastic/Recycled Rubber — each converts the other, plus Fuel, back into
 * itself). This DFS tracks which parts are currently being resolved
 * (`resolving`, i.e. ancestors on the current path) and, if a candidate's
 * inputs would loop back to one, skips it in favor of the next-ranked
 * candidate instead — falling all the way through to `unresolvedParts` only
 * if literally every candidate closes a cycle. This is what guarantees
 * Phase 2 below always terminates.
 *
 * Phase 2 (demand propagation): a Kahn's-algorithm topological pass,
 * starting from every part with no in-graph consumer (every target that
 * isn't ALSO an ingredient of another target's chain) — each part's
 * `machineCount` is only computed once every downstream consumer that needs
 * it (another recipe, or its own status as a target) has already
 * contributed its share of demand, so a part needed by two different
 * recipes — or selected as a target while also being a target's own
 * ingredient — gets exactly one producer node sized for the combined total,
 * not two independent (and wrong) ones.
 *
 * One node per PART, not per recipe: a multi-output recipe independently
 * selected as the best producer for two different demanded parts (rare —
 * most byproduct recipes aren't anyone's single cheapest route to either of
 * their outputs) ends up as two separate planned nodes rather than one
 * shared machine. Accepted for this generator's scope — PLAN.md's own
 * framing of this tool as a visual calculator, not a fully automatic BOM
 * optimizer; a user can merge duplicate machines by hand afterward.
 *
 * `options.disabledRecipes` (recipe names) are removed from consideration
 * entirely before a recipe is ever ranked — intended for the "which
 * alternates are available" checklist (`GenerateFactoryDialog.tsx`), though
 * it works for any recipe name, not just alternates. A part whose every
 * candidate recipe ends up disabled is reported the same way as a part with
 * no recipe at all — `unresolvedParts`, not a thrown error.
 *
 * `options.priority` (default `"balanced"`) picks WHICH recipe wins among a
 * part's candidates — see `recipePriority.ts`'s header for the full set and
 * how each is computed. This only changes recipe SELECTION; the demand
 * propagation and machine-count math below are identical regardless of
 * which recipe ends up chosen for each part.
 *
 * `options.allowConverters` (default `true`) is a SOFT exclusion for
 * Converter-machine recipes, unlike `disabledRecipes`'s hard one — when
 * `false`, a part's Converter candidates are still ruled out by default, but
 * with two exceptions that keep "Converters off" from silently breaking
 * something a Converter is the only real route to:
 *   1. **Necessity** — if every non-Converter candidate for this part is
 *      already unavailable (disabled, or there simply isn't one — e.g.
 *      "Excited Photonic Matter" has no producing recipe at all besides its
 *      own Converter one), the Converter candidates are allowed back in
 *      rather than reporting the part unresolved over a policy preference.
 *   2. **Already-appropriate tier** — if a Converter recipe would win
 *      anyway under the active `priority` ranking AND this part's own Tier
 *      is at or above the Converter machine's Tier (9-1), it's allowed:
 *      by the time a save has unlocked this part, Converters are already
 *      built, so excluding them just forces a needlessly worse recipe (the
 *      motivating real case: Dark Matter Residue, Tier 9-2, whose only
 *      non-Converter "producers" are OTHER Tier 9-2 recipes that make it as
 *      a side product of building an entire unrelated end-game machine).
 * Neither exception fires for a low-tier part a Converter recipe could
 * technically also produce (e.g. Iron Ore via "Iron Ore (Limestone)") —
 * its own Tier sits far below the Converter's, so exception 2 never
 * applies, and exception 1 doesn't either as long as its ordinary
 * extraction recipe remains available.
 *
 * `options.handleByproducts` (default `false`) populates
 * `FactoryPlan.byproductDisposals` — see that field's own doc comment for
 * the full disposal policy (raw-material reuse attempt, then a
 * single-input conversion attempt, then a fluid/gas-only packaging
 * attempt, then sink; nothing touches the main demand graph beyond the one
 * documented raw-material-reuse exception). Off by default: it adds real
 * nodes (one AWESOME Sink per disposal, plus a conversion machine — and,
 * for a packaged fluid/gas, its own small supporting chain — per disposal
 * that found one) the user didn't necessarily ask for, same reasoning as
 * `allowConverters` defaulting to a conservative choice.
 */
export interface PlanFactoryOptions {
  disabledRecipes?: ReadonlySet<string>;
  priority?: GenerationPriority;
  allowConverters?: boolean;
  handleByproducts?: boolean;
}

const CONVERTER_MACHINE_NAME = "Converter";

export function planFactory(
  gameData: GameData,
  targets: readonly FactoryTarget[],
  options: PlanFactoryOptions = {},
): FactoryPlan {
  const disabledRecipes = options.disabledRecipes ?? new Set<string>();
  const allowConverters = options.allowConverters ?? true;
  const selector = createRecipeSelector(gameData, options.priority ?? "balanced", disabledRecipes);
  const converterRecipeNames = new Set(
    (gameData.recipesByMachine.get(CONVERTER_MACHINE_NAME) ?? []).map((r) => r.name),
  );
  const converterTier = gameData.machinesByName.get(CONVERTER_MACHINE_NAME)?.tier;
  const discovered = new Map<string, DiscoveredRecipe>();
  const consumerCount = new Map<string, number>();
  const unresolvedParts: string[] = [];
  const unresolvedSet = new Set<string>();
  /** Parts currently on the DFS call stack — an ancestor of whatever's being resolved right now, i.e. a candidate whose inputs include one of these would close a cycle back to itself. */
  const resolving = new Set<string>();

  /** Whether `part`'s own Tier is at or above the Converter machine's — the second `allowConverters: false` exception (see this module's header). `false` if either Tier is unavailable (defensive; every real part/machine has one). */
  function partMeetsConverterTier(part: string): boolean {
    const partTier = gameData.partsByName.get(part)?.tier;
    return !!partTier && !!converterTier && compareTiers(partTier, converterTier) >= 0;
  }

  function resolvePart(part: string): void {
    if (discovered.has(part) || unresolvedSet.has(part) || resolving.has(part)) return;

    const hardFiltered = (gameData.recipesByPartAsOutput.get(part) ?? []).filter(
      (r) => !disabledRecipes.has(r.name),
    );
    if (hardFiltered.length === 0) {
      unresolvedParts.push(part);
      unresolvedSet.add(part);
      return;
    }

    // Soft Converter exclusion (see this module's header for the two
    // exceptions) — computed against `hardFiltered` so a converter the
    // alternate checklist ALSO disabled stays disabled regardless.
    let candidates = hardFiltered;
    if (!allowConverters) {
      const nonConverterCandidates = hardFiltered.filter((r) => !converterRecipeNames.has(r.name));
      if (nonConverterCandidates.length === 0) {
        // Exception 1 (necessity): every remaining candidate IS a
        // Converter recipe — keep them rather than reporting unresolved.
      } else {
        const bestOverall = selector.rank(part, hardFiltered)[0]!;
        const converterWinsFairly = converterRecipeNames.has(bestOverall.name) && partMeetsConverterTier(part);
        candidates = converterWinsFairly ? hardFiltered : nonConverterCandidates;
      }
    }

    resolving.add(part);
    let chosen:
      | { recipe: Recipe; ref: MachineRef; inputs: { part: string; perMachineRate: Rational }[] }
      | undefined;

    for (const candidate of selector.rank(part, candidates)) {
      // Reuses the Recipe Chooser's own machine/purity resolution (plain
      // machine vs. MultiMachine default variant) — `containerId`/`position`
      // are irrelevant here, only `.machine`/`.purity` are read.
      const built = buildNodeInputForRecipe({ gameData, recipe: candidate, containerId: "", position: { x: 0, y: 0 } });
      const ref: MachineRef = { machine: built.machine, purity: built.purity };

      const inputs: { part: string; perMachineRate: Rational }[] = [];
      let closesCycle = false;
      for (const p of candidate.parts) {
        if (!isNegative(p.amount)) continue;
        if (resolving.has(p.part)) {
          closesCycle = true;
          break;
        }
        inputs.push({ part: p.part, perMachineRate: abs(ratePerMachineAtFullClock(gameData, candidate, ref, p.part)) });
      }
      if (closesCycle) continue; // try the next-ranked candidate instead

      chosen = { recipe: candidate, ref, inputs };
      break;
    }

    if (!chosen) {
      // Every candidate for this part closes a cycle back to an ancestor
      // still being resolved (see this function's header — the canonical
      // real case is Recycled Plastic/Recycled Rubber with every acyclic
      // alternative disabled). Reporting this as unresolved, rather than
      // accepting a cyclic pick, is what keeps Phase 2 below a genuine DAG.
      resolving.delete(part);
      unresolvedParts.push(part);
      unresolvedSet.add(part);
      return;
    }

    for (const { part: inputPart } of chosen.inputs) {
      consumerCount.set(inputPart, (consumerCount.get(inputPart) ?? 0) + 1);
      resolvePart(inputPart);
    }

    discovered.set(part, {
      recipe: chosen.recipe,
      ref: chosen.ref,
      inputs: chosen.inputs,
      ratePerMachine: ratePerMachineAtFullClock(gameData, chosen.recipe, chosen.ref, part),
    });
    resolving.delete(part);
  }

  for (const target of targets) {
    resolvePart(target.part);
  }

  // Phase 2: topological demand propagation. Every target seeds its own
  // demand from outside the graph (summed if the same part was somehow
  // selected as a target more than once); `ready` starts with every
  // discovered part that has no in-graph consumer at all — ordinarily just
  // the targets themselves, but a target that's also an ingredient of
  // another target's chain correctly waits its turn instead.
  const demand = new Map<string, Rational>();
  for (const target of targets) {
    demand.set(target.part, add(demand.get(target.part) ?? ZERO, target.rate));
  }
  const pending = new Map(consumerCount);
  const machineCountByPart = new Map<string, Rational>();
  const order: string[] = [];
  const ready: string[] = [...discovered.keys()].filter((part) => (pending.get(part) ?? 0) === 0);
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

  // Defensive backstop, not an expected code path: Phase 1's cycle-avoiding
  // DFS guarantees every `discovered` part's inputs never point back to an
  // ancestor, so this topological pass should always fully drain `ready`
  // and finalize everything on its own. If that guarantee were ever
  // violated by a future change, report the leftover parts as unresolved
  // instead of computing a machine count from incomplete demand — a
  // visibly-missing node is a far better failure mode than one that looks
  // legitimate but silently under-reports what it needs (PLAN.md §5's
  // "convergence is not correctness" framing, applied here too).
  for (const part of discovered.keys()) {
    if (finalized.has(part)) continue;
    discovered.delete(part);
    unresolvedParts.push(part);
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
      // `MachineRef.machine` is typed `string | null` (it's `Pick<NodeRecord, ...>`, nullable
      // for non-recipe node kinds), but `buildNodeInputForRecipe` — the only place `info.ref`
      // is ever built, above — always resolves a real machine name for a recipe node.
      machine: info.ref.machine!,
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

  let byproductDisposals: ByproductDisposal[] = [];
  if (options.handleByproducts) {
    const sourcesByPart = collectByproductSources(gameData, nodes);
    const reuseByPart = applyByproductReuse(nodes, edges, discovered, sourcesByPart);
    byproductDisposals = planByproductDisposals(
      gameData,
      sourcesByPart,
      reuseByPart,
      disabledRecipes,
      allowConverters,
      options.priority,
    );
  }

  return { targets, nodes, edges, unresolvedParts, byproductDisposals };
}

/** `true` for a fluid or gas (`@scm/gamedata`'s `Part.fluid` doesn't distinguish the two — neither can go into an AWESOME Sink raw, so neither needs to here either). `false` (never blocks disposal) if the part is unknown for any reason — defensive; every real part has an entry. */
function isFluidPart(gameData: GameData, part: string): boolean {
  return gameData.partsByName.get(part)?.fluid === true;
}

/** Every non-primary positive output every `nodes` entry produces, grouped by part — the raw material for both `applyByproductReuse` and `planByproductDisposals` below. */
function collectByproductSources(
  gameData: GameData,
  nodes: readonly PlannedNode[],
): Map<string, { fromPart: string; rate: Rational }[]> {
  const sourcesByPart = new Map<string, { fromPart: string; rate: Rational }[]>();
  for (const node of nodes) {
    for (const p of node.recipe.parts) {
      if (!isPositive(p.amount) || p.part === node.part) continue; // p.part === node.part is the part this node was actually chosen to produce
      const rate = multiply(node.machineCount, ratePerMachineAtFullClock(gameData, node.recipe, { machine: node.machine, purity: node.purity }, p.part));
      if (isZero(rate)) continue;
      const list = sourcesByPart.get(p.part) ?? [];
      list.push({ fromPart: node.part, rate });
      sourcesByPart.set(p.part, list);
    }
  }
  return sourcesByPart;
}

/**
 * Phase 2.5 (opt-in, part of `options.handleByproducts`, runs before Phase
 * 3's disposal pass below): when a byproduct part is ALSO produced by its
 * own dedicated RAW-MATERIAL node elsewhere in the plan — `discovered`'s
 * entry for it has zero inputs, i.e. generation 0 — redirects as much of
 * that byproduct's combined supply as the raw node's own real demand can
 * absorb, shrinking the raw node's `machineCount` (mutated in place on
 * `nodes`) by exactly that much instead of routing 100% of it to disposal.
 * This is the ONE exception to `FactoryPlan.byproductDisposals`'s own
 * documented no-cascade policy, and it's safe specifically BECAUSE a raw
 * node has no inputs of its own: shrinking it can never cascade into
 * anything upstream needing its own re-sizing, unlike shrinking any other
 * kind of dedicated producer would. Skipped when the raw node's demand
 * comes from nowhere `edges` can route the byproduct's supply into (i.e.
 * it's a target with no in-graph consumer) — reusing there would shrink a
 * node's own output below what's visibly wired to receive it.
 */
function applyByproductReuse(
  nodes: PlannedNode[],
  edges: readonly PlannedEdge[],
  discovered: ReadonlyMap<string, DiscoveredRecipe>,
  sourcesByPart: ReadonlyMap<string, readonly { fromPart: string; rate: Rational }[]>,
): Map<string, { rate: Rational; intoParts: readonly string[] }> {
  const reuseByPart = new Map<string, { rate: Rational; intoParts: readonly string[] }>();
  for (const [part, sources] of sourcesByPart) {
    const rawInfo = discovered.get(part);
    if (!rawInfo || rawInfo.inputs.length > 0) continue; // not a raw-material node — shrinking it would cascade into its own inputs

    const node = nodes.find((n) => n.part === part);
    if (!node || !isPositive(node.demand)) continue;

    const intoParts = edges.filter((e) => e.fromPart === part).map((e) => e.toPart);
    if (intoParts.length === 0) continue; // nowhere in-graph to route the replacement supply into

    const totalSupply = sources.reduce((sum, s) => add(sum, s.rate), ZERO);
    const reused = compare(totalSupply, node.demand) <= 0 ? totalSupply : node.demand;
    if (!isPositive(reused)) continue;

    node.machineCount = isZero(rawInfo.ratePerMachine) ? ZERO : divide(subtract(node.demand, reused), rawInfo.ratePerMachine);
    reuseByPart.set(part, { rate: reused, intoParts });
  }
  return reuseByPart;
}

/**
 * Sizes a conversion machine for `chosen` against `disposalRate` — shared by
 * both the single-input and packaging paths in `findByproductConversion`
 * below (a packaging recipe is sized identically against ITS byproduct
 * input; only its second input differs, handled separately by
 * `buildPackagingConversion`).
 */
function buildConversionMachine(
  gameData: GameData,
  chosen: Recipe,
  byproductPart: string,
  disposalRate: Rational,
): ByproductDisposal["conversion"] {
  const built = buildNodeInputForRecipe({ gameData, recipe: chosen, containerId: "", position: { x: 0, y: 0 } });
  const ref: MachineRef = { machine: built.machine, purity: built.purity };
  const consumptionRate = abs(ratePerMachineAtFullClock(gameData, chosen, ref, byproductPart));
  if (isZero(consumptionRate)) return undefined;
  const machineCount = divide(disposalRate, consumptionRate);
  const output = primaryPart(chosen);
  if (!output) return undefined;
  return {
    recipe: chosen,
    // See the matching comment in `resolvePart` above — `ref.machine` is always non-null here.
    machine: ref.machine!,
    purity: ref.purity,
    machineCount,
    outputPart: output.part,
    outputRate: multiply(machineCount, ratePerMachineAtFullClock(gameData, chosen, ref, output.part)),
  };
}

/**
 * A packaging recipe (`chosen`) needs a SECOND input besides `byproductPart`
 * itself — e.g. Water needs an Empty Canister to become Packaged Water —
 * resolved via a nested `planFactory` call for that second input alone (see
 * `ByproductDisposal.conversion.supportChain`'s own doc comment for why this
 * is allowed here specifically). Returns `undefined` if that nested call
 * can't fully resolve it (its own `unresolvedParts` is non-empty) — the
 * caller then falls through to the next-ranked packaging candidate, if any.
 */
function buildPackagingConversion(
  gameData: GameData,
  chosen: Recipe,
  byproductPart: string,
  disposalRate: Rational,
  disabledRecipes: ReadonlySet<string>,
  allowConverters: boolean,
  priority: GenerationPriority | undefined,
): ByproductDisposal["conversion"] {
  const base = buildConversionMachine(gameData, chosen, byproductPart, disposalRate);
  if (!base) return undefined;

  const carrierInput = chosen.parts.find((p) => isNegative(p.amount) && p.part !== byproductPart);
  if (!carrierInput) return base; // shouldn't happen — `chosen` was filtered to exactly 2 inputs, one of which is `byproductPart`

  const carrierRate = multiply(
    base.machineCount,
    abs(ratePerMachineAtFullClock(gameData, chosen, { machine: base.machine, purity: base.purity }, carrierInput.part)),
  );
  if (!isPositive(carrierRate)) return base;

  const carrierPlan = planFactory(gameData, [{ part: carrierInput.part, rate: carrierRate }], {
    priority,
    disabledRecipes,
    allowConverters,
  });
  if (carrierPlan.unresolvedParts.length > 0) return undefined; // this candidate's carrier can't actually be built — try the next-ranked packaging recipe instead

  return {
    ...base,
    supportChain: { part: carrierInput.part, rate: carrierRate, nodes: carrierPlan.nodes, edges: carrierPlan.edges },
  };
}

/**
 * Finds the best available way to consume `byproductPart` outright, sized
 * against `disposalRate`: a single-input recipe first (cheapest, no support
 * chain needed), then — ONLY for a fluid/gas, since a solid with no
 * single-input route genuinely has nothing else to try — a packaging recipe
 * (exactly 2 inputs: `byproductPart` plus a carrier like an empty canister)
 * with the carrier's own supply chain resolved via `buildPackagingConversion`.
 * Every candidate, from either path, is required to produce a SOLID output
 * (`!isFluidPart`) — converting one unsinkable fluid into another wouldn't
 * actually solve anything. Returns `undefined` if nothing works, meaning
 * `disposalRate` either goes to the sink raw (a solid) or is left un-wired
 * (a fluid/gas — see `ByproductDisposal.rawSinkAllowed`).
 */
function findByproductConversion(
  gameData: GameData,
  byproductPart: string,
  disposalRate: Rational,
  disabledRecipes: ReadonlySet<string>,
  allowConverters: boolean,
  priority: GenerationPriority | undefined,
  converterRecipeNames: ReadonlySet<string>,
): ByproductDisposal["conversion"] {
  const solidOutputCandidates = (gameData.recipesByPartAsInput.get(byproductPart) ?? [])
    .filter((r) => !disabledRecipes.has(r.name))
    .filter((r) => allowConverters || !converterRecipeNames.has(r.name))
    .filter((r) => {
      const output = primaryPart(r);
      return !!output && !isFluidPart(gameData, output.part);
    });

  // Reuses the same "cheapest by production-step depth" ordering the main
  // graph defaults to — the active `priority` ranking doesn't apply cleanly
  // here (it's built around "which recipe best PRODUCES this part," not
  // "which recipe should consume my byproduct"), so this always uses the
  // one ranking that's a general-purpose recipe quality heuristic
  // regardless of direction.
  const singleInput = solidOutputCandidates.filter((r) => r.parts.filter((p) => isNegative(p.amount)).length === 1);
  for (const chosen of sortRecipesForChooser(gameData, singleInput)) {
    const conversion = buildConversionMachine(gameData, chosen, byproductPart, disposalRate);
    if (conversion) return conversion;
  }

  if (!isFluidPart(gameData, byproductPart)) return undefined;

  const packaging = solidOutputCandidates.filter((r) => r.parts.filter((p) => isNegative(p.amount)).length === 2);
  for (const chosen of sortRecipesForChooser(gameData, packaging)) {
    const conversion = buildPackagingConversion(
      gameData,
      chosen,
      byproductPart,
      disposalRate,
      disabledRecipes,
      allowConverters,
      priority,
    );
    if (conversion) return conversion;
  }
  return undefined;
}

/**
 * Phase 3 (opt-in): for every byproduct `sourcesByPart` collected —
 * INCLUDING a byproduct part that happens to also have its own dedicated
 * producer elsewhere in the plan (see `FactoryPlan.byproductDisposals`'s own
 * doc comment), minus whatever `reuseByPart` already redirected — tries
 * `findByproductConversion` before falling back to sinking the raw
 * byproduct (only valid for a non-fluid/gas part — see
 * `ByproductDisposal.rawSinkAllowed`). See `FactoryPlan.byproductDisposals`'s
 * doc comment for why this (`disposalRate`'s own conversion/support chain
 * aside) never touches the main demand graph.
 */
function planByproductDisposals(
  gameData: GameData,
  sourcesByPart: ReadonlyMap<string, readonly { fromPart: string; rate: Rational }[]>,
  reuseByPart: ReadonlyMap<string, { rate: Rational; intoParts: readonly string[] }>,
  disabledRecipes: ReadonlySet<string>,
  allowConverters: boolean,
  priority: GenerationPriority | undefined,
): ByproductDisposal[] {
  const converterRecipeNames = new Set(
    (gameData.recipesByMachine.get(CONVERTER_MACHINE_NAME) ?? []).map((r) => r.name),
  );

  const disposals: ByproductDisposal[] = [];
  for (const [byproductPart, sources] of sourcesByPart) {
    const totalRate = sources.reduce((sum, s) => add(sum, s.rate), ZERO);
    const reuse = reuseByPart.get(byproductPart);
    const disposalRate = reuse ? subtract(totalRate, reuse.rate) : totalRate;
    if (!isPositive(disposalRate) && !reuse) continue; // nothing to report — shouldn't normally happen (a source implies a positive rate), defensive

    const conversion = isPositive(disposalRate)
      ? findByproductConversion(
          gameData,
          byproductPart,
          disposalRate,
          disabledRecipes,
          allowConverters,
          priority,
          converterRecipeNames,
        )
      : undefined;

    disposals.push({
      part: byproductPart,
      sources,
      totalRate,
      reuse,
      disposalRate,
      rawSinkAllowed: !isFluidPart(gameData, byproductPart),
      conversion,
    });
  }
  return disposals;
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
  /**
   * Reorders each column by a barycenter sweep (`computeOrganizedOrder`)
   * instead of plain alphabetical order, so a node tends to sit vertically
   * near its producers/consumers in the adjacent column — fewer visually
   * crossing connections. Off by default (alphabetical is simpler and fully
   * deterministic from the part name alone); the "Organize layout" checkbox
   * in `GenerateFactoryDialog.tsx` is what turns it on.
   */
  organize?: boolean;
}

/**
 * Barycenter/median heuristic for layered graph drawing (the standard
 * Sugiyama-framework technique dagre/similar tools use) — reorders each
 * generation's nodes so they tend to line up near whichever nodes they're
 * actually connected to in the ADJACENT column, instead of the arbitrary
 * (if deterministic) alphabetical order `layoutFactoryPlan` falls back to
 * without this. Alternates sweep direction each pass (left-to-right using
 * producer positions, then right-to-left using consumer positions) — a
 * handful of passes is standard practice for this heuristic; it doesn't
 * guarantee the minimum possible crossings (that's NP-hard in general), just
 * a visibly better arrangement than an order with no graph awareness at all.
 */
const ORGANIZE_SWEEP_PASSES = 4;

function computeOrganizedOrder(plan: FactoryPlan): Map<number, string[]> {
  const byGeneration = new Map<number, string[]>();
  for (const node of plan.nodes) {
    const column = byGeneration.get(node.generation) ?? [];
    column.push(node.part);
    byGeneration.set(node.generation, column);
  }
  for (const [generation, parts] of byGeneration) {
    byGeneration.set(generation, [...parts].sort((a, b) => a.localeCompare(b)));
  }

  const producersOf = new Map<string, string[]>();
  const consumersOf = new Map<string, string[]>();
  for (const edge of plan.edges) {
    (producersOf.get(edge.toPart) ?? producersOf.set(edge.toPart, []).get(edge.toPart)!).push(edge.fromPart);
    (consumersOf.get(edge.fromPart) ?? consumersOf.set(edge.fromPart, []).get(edge.fromPart)!).push(edge.toPart);
  }

  const generations = [...byGeneration.keys()].sort((a, b) => a - b);

  for (let pass = 0; pass < ORGANIZE_SWEEP_PASSES; pass++) {
    const leftToRight = pass % 2 === 0;
    const sweepOrder = leftToRight ? generations : [...generations].reverse();
    const neighborsOf = leftToRight ? producersOf : consumersOf;
    const adjacentGeneration = leftToRight ? (g: number) => g - 1 : (g: number) => g + 1;

    for (const generation of sweepOrder) {
      const referenceColumn = byGeneration.get(adjacentGeneration(generation));
      if (!referenceColumn) continue; // no adjacent column this direction (first/last generation)

      const current = byGeneration.get(generation)!;
      const withBarycenter = current.map((part, index) => {
        const neighborIndices = (neighborsOf.get(part) ?? [])
          .map((neighbor) => referenceColumn.indexOf(neighbor))
          .filter((i) => i >= 0);
        const barycenter =
          neighborIndices.length > 0
            ? neighborIndices.reduce((sum, i) => sum + i, 0) / neighborIndices.length
            : index; // no connected neighbor in the reference column — hold its current relative position
        return { part, barycenter };
      });
      withBarycenter.sort((a, b) => a.barycenter - b.barycenter || a.part.localeCompare(b.part));
      byGeneration.set(
        generation,
        withBarycenter.map((entry) => entry.part),
      );
    }
  }

  return byGeneration;
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

/** `PlannedNode.part` -> its canvas position. Raw materials (generation 0) land at the left, `plan.targets` at the far right of their own chains — matching every recipe node's own input-left/output-right port layout. Targets that share raw materials/intermediates naturally share those same left-hand columns instead of duplicating them. */
export function layoutFactoryPlan(plan: FactoryPlan, options: LayoutOptions = {}): Map<string, { x: number; y: number }> {
  const columnWidth = options.columnWidth ?? DEFAULT_COLUMN_WIDTH;
  const rowGap = options.rowGap ?? DEFAULT_ROW_GAP;
  const base = options.basePosition ?? { x: 0, y: 0 };
  const organizedOrder = options.organize ? computeOrganizedOrder(plan) : null;

  const byGeneration = new Map<number, PlannedNode[]>();
  for (const node of plan.nodes) {
    const column = byGeneration.get(node.generation) ?? [];
    column.push(node);
    byGeneration.set(node.generation, column);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [generation, columnNodes] of byGeneration) {
    // Deterministic stacking order — alphabetical by default, or the
    // barycenter-swept order from `computeOrganizedOrder` when
    // `options.organize` is set (see that function's own doc comment).
    const rank = organizedOrder?.get(generation);
    const sorted = rank
      ? [...columnNodes].sort((a, b) => rank.indexOf(a.part) - rank.indexOf(b.part))
      : [...columnNodes].sort((a, b) => a.part.localeCompare(b.part));
    let y = base.y;
    for (const node of sorted) {
      positions.set(node.part, { x: base.x + generation * columnWidth, y });
      y += estimateNodeHeight(node.recipe) + rowGap;
    }
  }
  return positions;
}

/** Rough card height for the sink's own node — it has no `recipe.parts` to size against (see `estimateNodeHeight`), so this just treats it as a 1-row card, plenty for its single wildcard input. */
const SINK_NODE_HEIGHT = HEADER_HEIGHT + PART_ROW_HEIGHT + FOOTER_HEIGHT;

export interface DisposalLayout {
  /** Keyed by `ByproductDisposal.part` — every disposal that actually needs one (see `needsDisposalNode`) gets its OWN sink node position (see this module's `layoutByproductDisposals` doc comment for why multiple sinks are expected across a plan, rather than funneling everything through one shared node). */
  sinkPositions: Map<string, { x: number; y: number }>;
  /** Keyed by `ByproductDisposal.part` — only present for disposals that have a `conversion` (a bare-sink disposal has no node of its own besides its sink). */
  conversionPositions: Map<string, { x: number; y: number }>;
  /** Keyed by `ByproductDisposal.part`, then by the support chain's OWN `PlannedNode.part` — only present for disposals whose `conversion.supportChain` is set (a packaging recipe that needed a second input, e.g. an empty canister). Every node in a given support chain is packed into ONE column, immediately left of its own conversion node, rather than spread across its own sub-generations — simple, and support chains are typically shallow. */
  supportChainPositions: Map<string, Map<string, { x: number; y: number }>>;
}

/** A disposal only gets real nodes when there's something left to actually dispose of, and it's actually possible to — see `ByproductDisposal.disposalRate`/`.rawSinkAllowed`'s own doc comments. Shared between `layoutByproductDisposals` and `applyFactoryPlan` so the two stay in lockstep about which disposals get nodes at all. */
export function needsDisposalNode(disposal: ByproductDisposal): boolean {
  return isPositive(disposal.disposalRate) && (!!disposal.conversion || disposal.rawSinkAllowed);
}

/**
 * Positions each of `plan.byproductDisposals`' conversion nodes (if any) and
 * its own dedicated AWESOME Sink one "level" (`layoutFactoryPlan`'s own
 * generation column) to the right of wherever the byproduct is actually
 * produced — a byproduct made mid-chain lands right next to its source
 * instead of being bunched, along with every other disposal in the plan,
 * into two columns strictly past the ENTIRE main graph. Each disposal gets
 * its own sink rather than sharing one plan-wide: `applyFactoryPlan` creates
 * one AWESOME Sink per entry here, so a plan with byproducts surfacing at
 * several different generations ends up with several sinks, each sitting
 * where it's actually needed. (A single disposal's own multiple SOURCES
 * still fan into that one disposal's one sink/conversion node exactly as
 * before — this only stops DIFFERENT byproducts from sharing a node.)
 *
 * Column occupancy — every main-graph node already in a generation, plus
 * every other disposal's own conversion/sink node already placed there — is
 * tracked so nothing added here ever visually overlaps anything else, in
 * either this function's own output or `layoutFactoryPlan`'s. Deliberately
 * kept as a separate function (not folded into `layoutFactoryPlan` itself)
 * since disposal nodes aren't part of `plan.nodes`/generations at all, just
 * an additive side-chain.
 */
export function layoutByproductDisposals(plan: FactoryPlan, options: LayoutOptions = {}): DisposalLayout {
  const columnWidth = options.columnWidth ?? DEFAULT_COLUMN_WIDTH;
  const rowGap = options.rowGap ?? DEFAULT_ROW_GAP;
  const base = options.basePosition ?? { x: 0, y: 0 };

  const generationByPart = new Map(plan.nodes.map((n) => [n.part, n.generation]));

  // Per-generation bump allocator: the first placement request into a given
  // column starts below every main-graph node already stacked there
  // (mirroring `layoutFactoryPlan`'s own per-column loop); every subsequent
  // request into that same column — main graph is fixed, but multiple
  // disposals' conversion/sink nodes can legitimately land in the same
  // column — stacks below whatever was placed there most recently.
  const nextY = new Map<number, number>();
  function place(generation: number, height: number): { x: number; y: number } {
    if (!nextY.has(generation)) {
      let y = base.y;
      for (const node of plan.nodes) {
        if (node.generation === generation) y += estimateNodeHeight(node.recipe) + rowGap;
      }
      nextY.set(generation, y);
    }
    const y = nextY.get(generation)!;
    nextY.set(generation, y + height + rowGap);
    return { x: base.x + generation * columnWidth, y };
  }

  const sourceGeneration = (disposal: ByproductDisposal): number =>
    disposal.sources.reduce((max, s) => Math.max(max, generationByPart.get(s.fromPart) ?? 0), 0);

  const conversionPositions = new Map<string, { x: number; y: number }>();
  const sinkPositions = new Map<string, { x: number; y: number }>();
  const supportChainPositions = new Map<string, Map<string, { x: number; y: number }>>();

  // Deterministic left-to-right, top-to-bottom order so column stacking is
  // stable and reproducible regardless of `plan.byproductDisposals`' own order.
  const ordered = [...plan.byproductDisposals]
    .filter(needsDisposalNode)
    .sort((a, b) => {
      const generationDiff = sourceGeneration(a) - sourceGeneration(b);
      return generationDiff !== 0 ? generationDiff : a.part.localeCompare(b.part);
    });

  for (const disposal of ordered) {
    const srcGen = sourceGeneration(disposal);
    if (disposal.conversion) {
      conversionPositions.set(disposal.part, place(srcGen + 1, estimateNodeHeight(disposal.conversion.recipe)));
      if (disposal.conversion.supportChain) {
        const supportPositions = new Map<string, { x: number; y: number }>();
        const supportNodes = [...disposal.conversion.supportChain.nodes].sort((a, b) => a.part.localeCompare(b.part));
        for (const supportNode of supportNodes) {
          supportPositions.set(supportNode.part, place(srcGen, estimateNodeHeight(supportNode.recipe)));
        }
        supportChainPositions.set(disposal.part, supportPositions);
      }
      sinkPositions.set(disposal.part, place(srcGen + 2, SINK_NODE_HEIGHT));
    } else {
      sinkPositions.set(disposal.part, place(srcGen + 1, SINK_NODE_HEIGHT));
    }
  }

  return { sinkPositions, conversionPositions, supportChainPositions };
}
