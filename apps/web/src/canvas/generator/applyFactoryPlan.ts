// Writes a `FactoryPlan` (pure graph math from `planFactory.ts`) into a live
// `SfmDocument` — one `addNode` per planned node, one `addEdge` per planned
// edge, all inside a single outer `doc.transact` so the whole generated
// chain lands as one undo step instead of one per node/edge (Yjs nests
// transactions into the outermost one for free — see `@scm/ydoc`'s
// `mutations.ts` header comment: every mutation helper already wraps its own
// `doc.transact`).
import { ZERO, add, toFractionString, type Rational } from "@scm/rational";
import { addEdge, addNode, type SfmDocument } from "@scm/ydoc";

import { WILDCARD_PART } from "../edges";
import {
  type FactoryPlan,
  type LayoutOptions,
  layoutByproductDisposals,
  layoutDepotTargets,
  layoutFactoryPlan,
  needsDisposalNode,
} from "./planFactory";

// Every generated node is pinned to its exact computed machine count
// (`limitMode: "machines"`) rather than left for a solver to propagate —
// correct in every solver mode (Manual/Basic/Full/None), including a
// document with no live solve at all. Same neutral gray the Recipe Chooser
// itself uses for a freshly-placed node (`filters.ts`'s `buildNodeInputForRecipe`).
const GENERATED_NODE_COLOR = "#4b5563";
/** Distinct color for byproduct-disposal and Dimensional Depot output nodes — visually sets them apart from the main production chain, same idea as `RecipeChooser.tsx`'s own per-node-kind color choices (and the same hex it uses for a manually-placed AWESOME Sink/Depot). */
const DISPOSAL_NODE_COLOR = "#7c3aed";

export interface ApplyFactoryPlanResult {
  /** `PlannedNode.part` -> the real node id it was created as. */
  nodeIdByPart: Map<string, string>;
  /** Every node id created by this call — `nodeIdByPart`'s values plus any byproduct-disposal sink/conversion/support-chain nodes, which aren't keyed by a plan part. The full set a caller should e.g. fit the viewport to. */
  createdNodeIds: string[];
}

/**
 * Materializes `plan` into `sfmDoc` under `containerId`, laid out via
 * `layoutFactoryPlan`. Returns the part->nodeId mapping so a caller can e.g.
 * select the newly-created nodes afterward.
 */
export function applyFactoryPlan(
  sfmDoc: SfmDocument,
  containerId: string,
  plan: FactoryPlan,
  layoutOptions: LayoutOptions = {},
): ApplyFactoryPlanResult {
  const positions = layoutFactoryPlan(plan, layoutOptions);
  // Shared column occupancy — see `createColumnPlacer`'s doc comment in
  // `planFactory.ts` — so a target that's ALSO a byproduct source doesn't
  // get its Depot and its disposal Sink placed on top of each other.
  const disposalOccupancy = new Map<number, number>();
  const disposalLayout = layoutByproductDisposals(plan, layoutOptions, disposalOccupancy);
  const depotPositions = layoutDepotTargets(plan, layoutOptions, disposalOccupancy);
  // Same aggregation `planFactory`'s own Phase 2 uses to seed `demand` from
  // `targets` — a depot is capped at exactly the ORIGINALLY REQUESTED rate
  // for its part, not that part's total in-graph demand (which can be
  // higher when the same part is also consumed elsewhere in the plan; that
  // portion already reaches its consumer via its own separate edge).
  const targetRateByPart = new Map<string, Rational>();
  for (const target of plan.targets) {
    targetRateByPart.set(target.part, add(targetRateByPart.get(target.part) ?? ZERO, target.rate));
  }
  const nodeIdByPart = new Map<string, string>();
  const createdNodeIds: string[] = [];

  sfmDoc.doc.transact(() => {
    for (const planned of plan.nodes) {
      const position = positions.get(planned.part) ?? { x: 0, y: 0 };
      const node = addGeneratedRecipeNode(sfmDoc, containerId, position, planned, GENERATED_NODE_COLOR);
      nodeIdByPart.set(planned.part, node.id);
      createdNodeIds.push(node.id);
    }

    for (const edge of plan.edges) {
      const fromNode = nodeIdByPart.get(edge.fromPart);
      const toNode = nodeIdByPart.get(edge.toPart);
      if (!fromNode || !toNode) continue; // shouldn't happen — both parts were just created above
      addEdge(sfmDoc, {
        containerId,
        part: edge.part,
        fromNode,
        fromPort: `out:${edge.part}`,
        toNode,
        toPort: `in:${edge.part}`,
        style: null,
        labelPos: null,
      });
    }

    // Byproduct disposal (`options.handleByproducts`, see `planFactory.ts`'s
    // own doc comments): each disposal gets its OWN AWESOME Sink — positioned
    // one level right of wherever its byproduct is actually produced, not
    // funneled through one sink shared by the whole plan — plus its own
    // conversion machine (and, for a packaged fluid/gas, that conversion's
    // own small supporting chain) first when one was found to route the
    // byproduct through.
    for (const disposal of plan.byproductDisposals) {
      // Reuse (`ByproductDisposal.reuse`): every source producing this
      // byproduct ALSO gets a direct edge into each of the raw producer's
      // existing consumers, alongside their existing edge from that
      // (already-shrunk, see `planFactory.ts`'s own `applyByproductReuse`)
      // raw producer — a real Satisfactory splitter naturally lets each
      // consumer draw what it needs first, so feeding a consumer from BOTH
      // the raw producer and the byproduct at once is exactly how a player
      // would wire this up by hand.
      if (disposal.reuse) {
        for (const source of disposal.sources) {
          const fromNode = nodeIdByPart.get(source.fromPart);
          if (!fromNode) continue;
          for (const intoPart of disposal.reuse.intoParts) {
            const toNode = nodeIdByPart.get(intoPart);
            if (!toNode) continue;
            addEdge(sfmDoc, {
              containerId,
              part: disposal.part,
              fromNode,
              fromPort: `out:${disposal.part}`,
              toNode,
              toPort: `in:${disposal.part}`,
              style: null,
              labelPos: null,
            });
          }
        }
      }

      // Whatever's left after reuse either has nowhere to go (reuse alone
      // covered it — `disposalRate` is zero) or genuinely can't be disposed
      // at all (a fluid/gas with no packaging route — `rawSinkAllowed` is
      // false and there's no `conversion`): leave it un-wired rather than a
      // broken or physically-invalid edge into a sink.
      if (!needsDisposalNode(disposal)) continue;

      const sinkPosition = disposalLayout.sinkPositions.get(disposal.part) ?? { x: 0, y: 0 };
      const sinkNode = addNode(sfmDoc, {
        containerId,
        kind: "sink",
        recipe: null,
        machine: "AWESOME Sink",
        x: sinkPosition.x,
        y: sinkPosition.y,
        title: "AWESOME Sink",
        color: DISPOSAL_NODE_COLOR,
        limit: null,
        limitMode: "ppm",
        clock: null,
        autoRound: false,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: null,
        splurgerVariant: null,
      });
      createdNodeIds.push(sinkNode.id);

      // Fan-in: every source producing THIS byproduct feeds the same
      // conversion node (or this disposal's own sink directly), same as any
      // other multiple-producers-into-one-consumer edge this app already
      // supports natively — different byproducts no longer share a node, but
      // multiple sources of the SAME byproduct still do.
      const disposalTargetNodeId = ((): string => {
        if (!disposal.conversion) return sinkNode.id;
        const position = disposalLayout.conversionPositions.get(disposal.part) ?? { x: 0, y: 0 };
        const conversionNode = addNode(sfmDoc, {
          containerId,
          kind: "recipe",
          recipe: disposal.conversion.recipe.name,
          machine: disposal.conversion.machine,
          x: position.x,
          y: position.y,
          title: disposal.conversion.recipe.name,
          color: DISPOSAL_NODE_COLOR,
          limit: toFractionString(disposal.conversion.machineCount),
          limitMode: "machines",
          clock: null,
          autoRound: false,
          shards: 0,
          purity: disposal.conversion.purity,
          beltTier: null,
          storageMode: null,
          splurgerVariant: null,
        });
        createdNodeIds.push(conversionNode.id);

        // Packaging support chain (e.g. Water needs an Empty Canister): its
        // own dedicated nodes/edges, entirely separate from `nodeIdByPart` —
        // never merged with the main graph or any other disposal's support
        // chain, same additive-side-chain reasoning as the disposal itself.
        if (disposal.conversion.supportChain) {
          const supportChain = disposal.conversion.supportChain;
          const supportPositions = disposalLayout.supportChainPositions.get(disposal.part);
          const supportNodeIdByPart = new Map<string, string>();
          for (const supportNode of supportChain.nodes) {
            const supportPosition = supportPositions?.get(supportNode.part) ?? { x: 0, y: 0 };
            const node = addGeneratedRecipeNode(sfmDoc, containerId, supportPosition, supportNode, DISPOSAL_NODE_COLOR);
            supportNodeIdByPart.set(supportNode.part, node.id);
            createdNodeIds.push(node.id);
          }
          for (const supportEdge of supportChain.edges) {
            const fromNode = supportNodeIdByPart.get(supportEdge.fromPart);
            const toNode = supportNodeIdByPart.get(supportEdge.toPart);
            if (!fromNode || !toNode) continue;
            addEdge(sfmDoc, {
              containerId,
              part: supportEdge.part,
              fromNode,
              fromPort: `out:${supportEdge.part}`,
              toNode,
              toPort: `in:${supportEdge.part}`,
              style: null,
              labelPos: null,
            });
          }
          // The support chain's own root — the node producing the carrier
          // part itself — feeds the conversion machine's carrier input port.
          const rootNodeId = supportNodeIdByPart.get(supportChain.part);
          if (rootNodeId) {
            addEdge(sfmDoc, {
              containerId,
              part: supportChain.part,
              fromNode: rootNodeId,
              fromPort: `out:${supportChain.part}`,
              toNode: conversionNode.id,
              toPort: `in:${supportChain.part}`,
              style: null,
              labelPos: null,
            });
          }
        }

        addEdge(sfmDoc, {
          containerId,
          part: disposal.conversion.outputPart,
          fromNode: conversionNode.id,
          fromPort: `out:${disposal.conversion.outputPart}`,
          toNode: sinkNode.id,
          toPort: `in:${WILDCARD_PART}`,
          style: null,
          labelPos: null,
        });
        return conversionNode.id;
      })();

      for (const source of disposal.sources) {
        const fromNode = nodeIdByPart.get(source.fromPart);
        if (!fromNode) continue; // shouldn't happen — every source is one of `plan.nodes`, created above
        addEdge(sfmDoc, {
          containerId,
          part: disposal.part,
          fromNode,
          fromPort: `out:${disposal.part}`,
          toNode: disposalTargetNodeId,
          toPort: disposal.conversion ? `in:${disposal.part}` : `in:${WILDCARD_PART}`,
          style: null,
          labelPos: null,
        });
      }
    }

    // Output routing (`options.routeOutputsToDepot`, see `planFactory.ts`'s
    // own doc comments): each depot-eligible target gets its OWN Dimensional
    // Depot Uploader — positioned one level right of the target's own node,
    // same "one node per part, not funneled through a shared node" policy
    // `byproductDisposals` above already follows for its sinks. A Depot only
    // ever receives ONE part (see `SinkNode.tsx`'s connection validation),
    // so — unlike a byproduct's sink, which can be fed by several sources —
    // this is always exactly one edge in. `limit` is pinned to the target's
    // own requested rate (`targetRateByPart`), not left "unlimited" — same
    // "every generated node gets an exact, pinned value" convention
    // `addGeneratedRecipeNode`'s own `limitMode: "machines"` already follows
    // for the main chain, rather than silently uploading everything a node
    // happens to produce.
    for (const part of plan.depotTargets) {
      const fromNode = nodeIdByPart.get(part);
      if (!fromNode) continue; // shouldn't happen — `depotTargets` only contains parts already created above
      const position = depotPositions.get(part) ?? { x: 0, y: 0 };
      const depotNode = addNode(sfmDoc, {
        containerId,
        kind: "depot",
        recipe: null,
        machine: "Dimensional Depot Uploader",
        x: position.x,
        y: position.y,
        title: "Dimensional Depot",
        color: DISPOSAL_NODE_COLOR,
        limit: toFractionString(targetRateByPart.get(part) ?? ZERO),
        limitMode: "ppm",
        clock: null,
        autoRound: false,
        shards: 0,
        purity: null,
        beltTier: null,
        storageMode: null,
        splurgerVariant: null,
      });
      createdNodeIds.push(depotNode.id);
      addEdge(sfmDoc, {
        containerId,
        part,
        fromNode,
        fromPort: `out:${part}`,
        toNode: depotNode.id,
        toPort: `in:${WILDCARD_PART}`,
        style: null,
        labelPos: null,
      });
    }
  });

  return { nodeIdByPart, createdNodeIds };
}

/** Shared `addNode` shape for both a main-graph `PlannedNode` and a byproduct-disposal support chain's own `PlannedNode`s (`ByproductDisposal.conversion.supportChain.nodes`) — identical fields either way, only the color differs. */
function addGeneratedRecipeNode(
  sfmDoc: SfmDocument,
  containerId: string,
  position: { x: number; y: number },
  planned: FactoryPlan["nodes"][number],
  color: string,
) {
  return addNode(sfmDoc, {
    containerId,
    kind: "recipe",
    recipe: planned.recipe.name,
    machine: planned.machine,
    x: position.x,
    y: position.y,
    title: planned.recipe.name,
    color,
    limit: toFractionString(planned.machineCount),
    limitMode: "machines",
    clock: null,
    autoRound: false,
    shards: 0,
    purity: planned.purity,
    beltTier: null,
    storageMode: null,
    splurgerVariant: null,
  });
}
