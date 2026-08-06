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

export interface CanvasDocContextValue {
  /** The single local, in-memory `SfmDocument` this canvas mount owns. */
  sfmDoc: SfmDocument;
  /**
   * The container new nodes should be added to. Always the root
   * container's id for now — there's no outpost drill-in yet (Job 013), so
   * every node this job's UI (and Job 009's Recipe Chooser) creates lives
   * directly in root.
   */
  containerId: string;
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
