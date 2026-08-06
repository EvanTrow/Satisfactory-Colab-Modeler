// Polls (via events, not an interval) a `Y.UndoManager`'s stack lengths so
// `CanvasView.tsx`'s Undo/Redo toolbar buttons can enable/disable
// correctly — per Job 007's own handoff notes: "listen for the manager's
// `stack-item-added`/`stack-item-popped`/`stack-cleared` events (or just
// poll `undoManager.undoStack.length`/`redoStack.length`)". This hook does
// both at once: it re-renders on those three events, then reads the stack
// lengths fresh at render time, which is simpler than threading counts
// through the events' own payloads.
import { useEffect, useReducer } from "react";

import type * as Y from "yjs";

export interface UndoRedoState {
  canUndo: boolean;
  canRedo: boolean;
}

export function useUndoRedoState(undoManager: Y.UndoManager): UndoRedoState {
  const [, forceRerender] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    const handleStackChange = () => forceRerender();
    undoManager.on("stack-item-added", handleStackChange);
    undoManager.on("stack-item-popped", handleStackChange);
    undoManager.on("stack-cleared", handleStackChange);
    // The stacks may already be non-empty (or have changed) between this
    // hook's initial render and this effect running — one extra sync read
    // costs nothing and avoids a stale first paint.
    forceRerender();
    return () => {
      undoManager.off("stack-item-added", handleStackChange);
      undoManager.off("stack-item-popped", handleStackChange);
      undoManager.off("stack-cleared", handleStackChange);
    };
  }, [undoManager]);

  return { canUndo: undoManager.undoStack.length > 0, canRedo: undoManager.redoStack.length > 0 };
}
