// Public surface of Job 012's selection/clipboard/undo-redo UI.
export {
  buildClipboard,
  deleteSelection,
  pasteClipboard,
  DEFAULT_PASTE_OFFSET,
  type ClipboardPayload,
  type PasteOffset,
  type PasteResult,
} from "./clipboard";
export {
  nodeBoundsRect,
  polylineIntersectsRect,
  rectFromPoints,
  rectsIntersect,
  segmentIntersectsRect,
  type Point,
  type Rect,
} from "./marqueeGeometry";
export { MarqueeOverlay, type MarqueeOverlayProps } from "./MarqueeOverlay";
export {
  useMarqueeSelection,
  type MarqueeOverlayRect,
  type UseMarqueeSelectionOptions,
  type UseMarqueeSelectionResult,
} from "./useMarqueeSelection";
export { useSelectionKeybinds, type UseSelectionKeybindsOptions } from "./useSelectionKeybinds";
export { useUndoRedoState, type UndoRedoState } from "./useUndoRedoState";
