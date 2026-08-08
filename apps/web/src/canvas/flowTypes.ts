// Shared `<ReactFlow>` `nodeTypes`/`edgeTypes` maps — module-level constants
// (not created inside a component) so React Flow never sees a new object
// identity on every render, a documented React Flow footgun that triggers a
// console warning and forces an internal remount of every custom node/edge.
// Extracted out of `CanvasView.tsx` so the landing page's read-only
// `SampleFactoryPreview.tsx` (its own, separate `<ReactFlow>` instance) can
// import the exact same node/edge renderers instead of redefining them.
import { RecipeNode, SinkNode, SplurgerNode, StorageNode } from "./nodes";
import { BlueprintNode, OutpostNode, BoundaryEdge } from "./outposts";
import { ConnectionEdge } from "./edges";

/** `"recipe"` matches the `type` string `useYjsSync.ts`'s `nodeRecordToFlowNode` assigns to every `kind: "recipe"` node; `"outpost"` matches `containerToOutpostFlowNode`'s synthetic boundary nodes. */
export const nodeTypes = {
  recipe: RecipeNode,
  outpost: OutpostNode,
  blueprint: BlueprintNode,
  splurger: SplurgerNode,
  sink: SinkNode,
  depot: SinkNode,
  storage: StorageNode,
};

/** `"part"` matches what `useYjsSync.ts` assigns to a normal direct edge; `"boundary"` matches a boundary-crossing projected edge (`outposts/BoundaryEdge.tsx`). */
export const edgeTypes = { part: ConnectionEdge, boundary: BoundaryEdge };
