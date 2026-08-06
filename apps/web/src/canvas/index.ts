// Public surface of Job 008's canvas skeleton. See PLAN.md §7's
// `apps/web/src/canvas/` entry and jobs/008-canvas-skeleton.md's Handoff
// notes for how this fits together.
export { CanvasView } from "./CanvasView";
export { CanvasDocContext, useCanvasDoc, type CanvasDocContextValue } from "./CanvasDocContext";
export {
  useYjsSync,
  nodeRecordToFlowNode,
  edgeRecordToFlowEdge,
  type CanvasNode,
  type CanvasEdge,
  type CanvasNodeData,
  type UseYjsSyncResult,
} from "./useYjsSync";
