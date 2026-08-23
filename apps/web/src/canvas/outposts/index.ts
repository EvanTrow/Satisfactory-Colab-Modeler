// Public surface of Job 013's outposts (nested containers) work.
export {
  boundaryPortId,
  buildContainerParentMap,
  computeOutpostPorts,
  isContainerWithinSubtree,
  outpostBoundaryHandleId,
  resolveNodeLocation,
  type ContainerParentMap,
  type DerivedOutpostPort,
  type NodeLocation,
} from "./portMapping";
export { computeVisibleEdges, type ProjectedEdge } from "./visibleGraph";
export { computeBreadcrumbPath } from "./breadcrumbs";
export {
  deleteOutpost,
  deleteOutpostWithContents,
  moveNodeToContainer,
  type DeleteOutpostResult,
} from "./reparent";
export {
  LOCKED_NODE_KINDS,
  OUTPOST_INPUT_KIND,
  OUTPOST_OUTPUT_KIND,
  computeIoDanglingParts,
  computeIoNodePorts,
  computeIoPartRate,
  ensureOutpostIoNodes,
  isOutpostIoKind,
  outpostInputNodeId,
  outpostOutputNodeId,
  type IoPortRow,
} from "./io";
export { OutpostNode } from "./OutpostNode";
export { OutpostIoNode } from "./OutpostIoNode";
export { NodeContextMenu, type NodeContextMenuProps, type NodeContextMenuState } from "./NodeContextMenu";
export { DeleteOutpostDialog, type DeleteOutpostDialogProps } from "./DeleteOutpostDialog";
