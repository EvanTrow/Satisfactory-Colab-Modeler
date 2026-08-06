// React context that exposes the live `SfmDocument` (from `@scm/ydoc`, Job
// 007) to anything mounted underneath `<CanvasView>` — panels, dev tools,
// and (starting with Job 009) the Recipe Chooser modal all need a way to
// call `addNode`/`addEdge`/etc. against the *same* in-memory document
// `CanvasView` created, not a copy.
//
// This deliberately hands out the raw `SfmDocument`, not a set of
// pre-bound mutation callbacks: `@scm/ydoc`'s mutation helpers
// (`addNode`, `moveNode`, ...) all take `(sfmDoc, ...)` as plain functions,
// so `const { sfmDoc } = useCanvasDoc()` plus `import { addNode } from
// "@scm/ydoc"` is all a descendant component needs. See
// `jobs/008-canvas-skeleton.md`'s Handoff notes for the full contract.
import { createContext, useContext } from "react";

import type { SfmDocument } from "@scm/ydoc";
import type * as Y from "yjs";

export interface CanvasDocContextValue {
  /** The single local, in-memory `SfmDocument` this canvas mount owns. */
  sfmDoc: SfmDocument;
  /**
   * Job 013: the container currently being *viewed* — i.e. what's rendered
   * on `<ReactFlow>` right now and what new nodes/edges/outposts get
   * created into (the Recipe Chooser, paste, "New Outpost", drag-to-connect
   * all read this, not `rootContainerId`). This used to be a fixed value
   * (always the root container) before drill-in navigation existed —
   * it's now stateful, lifted into `CanvasView`'s own `useState` and
   * threaded through here so it updates (and every descendant re-renders
   * against the new value) whenever `navigateToContainer` is called.
   */
  containerId: string;
  /**
   * The fixed id of the document's one root container (`kind: "root"`),
   * created once in `createLocalCanvasDocument` and never re-created or
   * removed. Exposed separately from `containerId` for the rare cases that
   * specifically need "the top of the tree" regardless of what's currently
   * being viewed — e.g. the breadcrumb trail's leftmost crumb, or deciding
   * whether "move to parent container" should be offered at all.
   */
  rootContainerId: string;
  /**
   * Switches the current view to a different container — the whole
   * mechanism behind "drill in" (pass an outpost's id) and "drill out via
   * breadcrumbs" (pass an ancestor's id, possibly several levels up in one
   * call). Does nothing but flip `containerId`; it's `useYjsSync.ts`'s job
   * to notice the change and re-derive what's visible (see its own header
   * comment), and `selection`'s id-based "carry selection over by id"
   * mechanism (Job 012) naturally drops any selection that doesn't exist
   * in the new view, since node/container ids are never reused across
   * containers — no separate "clear selection on navigate" step was needed
   * (confirmed in this job's manual verification; see Handoff notes).
   */
  navigateToContainer: (containerId: string) => void;
  /**
   * Job 012: the single `Y.UndoManager` for this open document — see
   * `@scm/ydoc`'s `createUndoManager` (Job 007). Created once per
   * `CanvasView` mount (in `createLocalCanvasDocument`, alongside `sfmDoc`
   * itself), not per component, so every descendant that wants to trigger
   * or react to undo/redo (currently just `useSelectionKeybinds.ts`'s
   * Ctrl/Cmd+Z/Y and `CanvasView.tsx`'s toolbar buttons) shares the exact
   * same manager and stack.
   */
  undoManager: Y.UndoManager;
}

export const CanvasDocContext = createContext<CanvasDocContextValue | null>(null);

/**
 * Reads the live `SfmDocument` + current container id. Throws if called
 * outside a `<CanvasView>` subtree, same fail-fast pattern as most
 * React context hooks — there is no sensible default document to fall
 * back to.
 */
export function useCanvasDoc(): CanvasDocContextValue {
  const value = useContext(CanvasDocContext);
  if (!value) {
    throw new Error("useCanvasDoc() must be called underneath <CanvasView>");
  }
  return value;
}
