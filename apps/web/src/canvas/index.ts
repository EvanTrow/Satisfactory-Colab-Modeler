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
  type CanvasEdgeData,
  type UseYjsSyncResult,
} from "./useYjsSync";
export {
  RecipeNode,
  defaultLimitMode,
  type RecipeNodeValidity,
  type RecipeNodeValidityState,
} from "./nodes";
export {
  ConnectionEdge,
  connectPorts,
  isValidPortConnection,
  parsePortHandleId,
  reconnectEdge,
  resolveEdgeEndpoints,
  useConnectionHandlers,
  type ConnectionHandlers,
  type ConnectionLike,
  type PortInfo,
  type ResolvedEndpoints,
} from "./edges";
export { isDoubleClick, DOUBLE_CLICK_MS, DOUBLE_CLICK_PX, type ClickPoint } from "./doubleClick";
export {
  buildClipboard,
  deleteSelection,
  pasteClipboard,
  DEFAULT_PASTE_OFFSET,
  nodeBoundsRect,
  polylineIntersectsRect,
  rectFromPoints,
  rectsIntersect,
  segmentIntersectsRect,
  MarqueeOverlay,
  useMarqueeSelection,
  useSelectionKeybinds,
  useUndoRedoState,
  type ClipboardPayload,
  type PasteOffset,
  type PasteResult,
  type MarqueeOverlayProps,
  type MarqueeOverlayRect,
  type UseMarqueeSelectionOptions,
  type UseMarqueeSelectionResult,
  type UseSelectionKeybindsOptions,
  type UndoRedoState,
} from "./selection";
