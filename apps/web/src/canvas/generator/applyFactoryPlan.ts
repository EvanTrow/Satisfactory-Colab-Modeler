// Writes a `FactoryPlan` (pure graph math from `planFactory.ts`) into a live
// `SfmDocument` — one `addNode` per planned node, one `addEdge` per planned
// edge, all inside a single outer `doc.transact` so the whole generated
// chain lands as one undo step instead of one per node/edge (Yjs nests
// transactions into the outermost one for free — see `@scm/ydoc`'s
// `mutations.ts` header comment: every mutation helper already wraps its own
// `doc.transact`).
import { toFractionString } from "@scm/rational";
import { addEdge, addNode, type SfmDocument } from "@scm/ydoc";

import { type FactoryPlan, type LayoutOptions, layoutFactoryPlan } from "./planFactory";

// Every generated node is pinned to its exact computed machine count
// (`limitMode: "machines"`) rather than left for a solver to propagate —
// correct in every solver mode (Manual/Basic/Full/None), including a
// document with no live solve at all. Same neutral gray the Recipe Chooser
// itself uses for a freshly-placed node (`filters.ts`'s `buildNodeInputForRecipe`).
const GENERATED_NODE_COLOR = "#4b5563";

export interface ApplyFactoryPlanResult {
  /** `PlannedNode.part` -> the real node id it was created as. */
  nodeIdByPart: Map<string, string>;
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
  const nodeIdByPart = new Map<string, string>();

  sfmDoc.doc.transact(() => {
    for (const planned of plan.nodes) {
      const position = positions.get(planned.part) ?? { x: 0, y: 0 };
      const node = addNode(sfmDoc, {
        containerId,
        kind: "recipe",
        recipe: planned.recipe.name,
        machine: planned.machine,
        x: position.x,
        y: position.y,
        title: planned.recipe.name,
        color: GENERATED_NODE_COLOR,
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
      nodeIdByPart.set(planned.part, node.id);
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
      });
    }
  });

  return { nodeIdByPart };
}
