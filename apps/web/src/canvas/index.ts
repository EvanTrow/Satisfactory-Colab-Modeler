// Public surface of Job 008's canvas skeleton. See PLAN.md §7's
// `apps/web/src/canvas/` entry and jobs/008-canvas-skeleton.md's Handoff
// notes for how this fits together.
export { CanvasView } from "./CanvasView";
export { CanvasDocContext, useCanvasDoc, type CanvasDocContextValue } from "./CanvasDocContext";
// Job 019: Job 018's live solver output, threaded through context so
// `RecipeNode.tsx`/`panels/SummaryPanel.tsx` don't each spin up their own
// `useSolver` scheduler/worker pair — see this module's own header comment.
export { SolverResultContext, useSolverResult } from "./SolverResultContext";
export { Breadcrumbs, type BreadcrumbsProps } from "./Breadcrumbs";
export {
  useYjsSync,
  nodeRecordToFlowNode,
  containerToOutpostFlowNode,
  type CanvasNode,
  type CanvasEdge,
  type CanvasNodeData,
  type CanvasEdgeData,
  type UseYjsSyncResult,
} from "./useYjsSync";
export {
  boundaryPortId,
  buildContainerParentMap,
  computeOutpostPorts,
  isContainerWithinSubtree,
  resolveNodeLocation,
  computeVisibleEdges,
  computeBreadcrumbPath,
  deleteOutpost,
  moveNodeToContainer,
  OutpostNode,
  BoundaryEdge,
  NodeContextMenu,
  type ContainerParentMap,
  type DerivedOutpostPort,
  type NodeLocation,
  type ProjectedEdge,
  type DeleteOutpostResult,
  type NodeContextMenuProps,
  type NodeContextMenuState,
} from "./outposts";
export {
  RecipeNode,
  defaultLimitMode,
  computeNodeValidityState,
  type RecipeNodeValidity,
  type RecipeNodeValidityState,
  type IncidentEdgeRef,
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
// Job 015: doc load/save. Exported from the barrel (not just used
// internally by CanvasView.tsx) since Job 016 (IndexedDB cache +
// project_versions restore) builds directly on top of this — see
// jobs/015-doc-persistence.md's Handoff notes for the exact contract.
export {
  fetchProjectDoc,
  pushProjectDocUpdate,
  listProjectVersions,
  saveProjectVersion,
  restoreProjectVersion,
  type ProjectVersionInfo,
  type RestoreVersionResult,
} from "./persistence/docApi";
export { bytesToBase64, base64ToBytes } from "./persistence/base64";
export {
  createUpdateQueue,
  type CreateUpdateQueueOptions,
  type UpdateQueue,
  type SaveStatus,
} from "./persistence/updateQueue";
export {
  useProjectDocument,
  type ProjectDocumentState,
  type StaticCanvasDoc,
} from "./persistence/useProjectDocument";
// Job 016: the autosave indicator + version-history/restore UI, both built
// directly on top of the exports above.
export {
  SaveStatusIndicator,
  type SaveStatusIndicatorProps,
} from "./persistence/SaveStatusIndicator";
export { VersionPanel, type VersionPanelProps } from "./persistence/VersionPanel";
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
