// Shared `<ReactFlow>` `nodeTypes`/`edgeTypes` maps — module-level constants
// (not created inside a component) so React Flow never sees a new object
// identity on every render, a documented React Flow footgun that triggers a
// console warning and forces an internal remount of every custom node/edge.
// Extracted out of `CanvasView.tsx` so the landing page's read-only
// `SampleFactoryPreview.tsx` (its own, separate `<ReactFlow>` instance) can
// import the exact same node/edge renderers instead of redefining them.
import { RecipeNode, SinkNode, SplurgerNode, StorageNode } from "./nodes";
import { OutpostIoNode, OutpostNode } from "./outposts";
import { ConnectionEdge } from "./edges";

/** `"recipe"` matches the `type` string `useYjsSync.ts`'s `nodeRecordToFlowNode` assigns to every `kind: "recipe"` node; `"outpost"` matches `containerToOutpostFlowNode`'s synthetic boundary nodes. */
export const nodeTypes = {
  recipe: RecipeNode,
  outpost: OutpostNode,
  splurger: SplurgerNode,
  sink: SinkNode,
  depot: SinkNode,
  storage: StorageNode,
  "outpost-input": OutpostIoNode,
  "outpost-output": OutpostIoNode,
};

/**
 * `"part"` matches what `useYjsSync.ts` assigns to a normal direct edge;
 * `"boundary"` matches a boundary-crossing projected edge (an edge redirected
 * to an outpost's boundary node, `outposts/visibleGraph.ts`). Both render
 * through the same `ConnectionEdge` — a boundary edge only ever renders in
 * the one view where it's visible at all, so its waypoints are just as
 * meaningful there as any other edge's; `ConnectionEdge` reads
 * `data.projected` itself to pick the boundary-crossing visual treatment
 * (dashed amber stroke, tooltip wording) without needing a separate
 * component.
 */
export const edgeTypes = { part: ConnectionEdge, boundary: ConnectionEdge };
