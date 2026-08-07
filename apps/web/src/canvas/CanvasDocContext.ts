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

import type { AwarenessHandle, LocalPresenceControls } from "../collab";

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
  /**
   * Job 021: the live `Awareness` instance for this project (see
   * `persistence/useProjectDocument.ts`'s `StaticCanvasDoc.awareness`) —
   * genuinely ephemeral presence state, never `sfmDoc`/Postgres. Handed out
   * raw (not pre-wrapped in React state) the same way `sfmDoc` is: a
   * descendant that wants to *read* remote peers' live state calls
   * `useRemotePresence(awareness)` itself (`collab/useRemotePresence.ts`) —
   * deliberately not a single shared subscription baked into this context's
   * own value, so a high-frequency change (a peer's cursor moving) only
   * re-renders the specific components that actually read presence, not
   * every consumer of this whole context on every mouse move anywhere on
   * anyone's screen. See `collab/useLocalPresence.ts`'s header comment for
   * why the *local* side (`localPresence` below) is different: publishing
   * needs to happen exactly once per document mount, so that hook is called
   * once in `CanvasView.tsx`'s `CanvasViewReady` and its returned setters
   * are threaded through here instead.
   */
  awareness: AwarenessHandle;
  /**
   * Job 021: this client's own presence setters (`setCursor`/`setSelection`/
   * `setEditingField`), from `collab/useLocalPresence.ts` — called from
   * `CanvasView.tsx`'s `CanvasFlow` (mousemove → cursor, React Flow
   * selection → selection) and `nodes/RecipeNode.tsx` (limit/clock/shards
   * focus/blur → editingField).
   */
  localPresence: LocalPresenceControls;
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
