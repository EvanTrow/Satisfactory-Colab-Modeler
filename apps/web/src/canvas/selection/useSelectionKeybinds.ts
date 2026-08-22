// Standard cut/copy/paste/delete/select-all/undo/redo keybinds (Job 012 —
// PLAN.md §2's "Select" row: "Standard cut/copy/paste/delete keybinds", and
// §3's "per-user undo/redo"). All the actual doc-mutation/id-regeneration
// logic lives in `clipboard.ts` (React-free, independently unit-tested);
// this hook wires copy/cut/paste to the browser's native `copy`/`cut`/
// `paste` `ClipboardEvent`s (not the async `navigator.clipboard` API) —
// the same pattern canvas apps like Figma/Excalidraw use, since Ctrl+C/X/V
// fire these events regardless of there being an actual DOM text selection,
// they work synchronously with no permission prompt, and (crucially for
// this feature) they put real text on the *system* clipboard: pasteable
// into another browser window/project, or into a chat message to hand a
// selection to another person.
import { useEffect } from "react";

import type { Point, SfmDocument } from "@scm/ydoc";
import type { EdgeChange, NodeChange } from "@xyflow/react";
import type * as Y from "yjs";

import { LOCKED_NODE_KINDS, deleteOutpost } from "../outposts";
import type { CanvasEdge, CanvasNode, UseYjsSyncResult } from "../useYjsSync";
import { buildClipboard, deleteSelection, deserializeClipboard, pasteClipboard, pasteOffsetForCenter, serializeClipboard } from "./clipboard";

export interface UseSelectionKeybindsOptions {
  sfmDoc: SfmDocument;
  containerId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onNodesChange: UseYjsSyncResult["onNodesChange"];
  onEdgesChange: UseYjsSyncResult["onEdgesChange"];
  undoManager: Y.UndoManager;
  /** False while e.g. the Recipe Chooser modal is open — see this file's header comment on why the whole hook is gated rather than relying solely on the focused-input check below. */
  enabled: boolean;
  /**
   * The current viewport's center, in document/flow coordinates — a paste
   * centers the pasted group here instead of reproducing the copied
   * position verbatim (see `clipboard.ts`'s `pasteOffsetForCenter`).
   * `null`/omitted falls back to `DEFAULT_PASTE_OFFSET`.
   */
  getPasteCenter?: () => Point | null;
}

/** True if `target` is a form control the browser's own text-editing keys (Backspace/Delete/Ctrl+C/etc.) should be left alone for — `RecipeNode.tsx`'s limit/clock fields being the concrete case that matters here: deleting text in one of those must never delete the node underneath it. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Wires delete/select-all/undo/redo to `window` keydown events, and
 * copy/cut/paste to `document`'s native `copy`/`cut`/`paste` `ClipboardEvent`s
 * (see this file's header comment). Document/window-level (not a
 * focused-element listener) on purpose, same pattern `RecipeChooser.tsx`'s
 * own Escape-to-close handler already uses — there's no dedicated "canvas
 * has focus" concept in this app yet, and the `enabled` flag plus
 * `isEditableTarget` guard cover the cases that actually matter (a modal
 * open, or a text field focused).
 */
export function useSelectionKeybinds(options: UseSelectionKeybindsOptions): void {
  const { sfmDoc, containerId, nodes, edges, onNodesChange, onEdgesChange, undoManager, enabled, getPasteCenter } = options;

  useEffect(() => {
    if (!enabled) return;

    /**
     * Outpost/Blueprint rework: excludes the two locked `outpost-input`/
     * `outpost-output` pass-through nodes (`outposts/io.ts`'s
     * `LOCKED_NODE_KINDS`) from every selection-driven action this hook
     * performs (copy/cut/delete) — they're structurally tied to their own
     * container and were never meant to be duplicated or removed via a
     * generic selection gesture, matching `NodeContextMenu.tsx`'s own
     * `locked` guard on the right-click menu.
     */
    function selectedNodeIds(): string[] {
      return nodes
        .filter((node) => node.selected && !(node.data.record && LOCKED_NODE_KINDS.has(node.data.record.kind)))
        .map((node) => node.id);
    }
    function selectedEdgeIds(): string[] {
      return edges.filter((edge) => edge.selected).map((edge) => edge.id);
    }
    /**
     * Job 013: a selected node in the current view is either a real
     * `@scm/ydoc` node (`data.record` set) or a synthetic outpost boundary
     * node (`data.container` set — see `useYjsSync.ts`'s
     * `containerToOutpostFlowNode`). They need different delete handling
     * below (`deleteSelection` vs `deleteOutpost`), so split once here
     * rather than at each call site.
     */
    function selectedOutpostIds(): string[] {
      return nodes.filter((node) => node.selected && node.data.container).map((node) => node.id);
    }
    function selectedRealNodeIds(): string[] {
      return nodes
        .filter(
          (node) =>
            node.selected && !node.data.container && !(node.data.record && LOCKED_NODE_KINDS.has(node.data.record.kind)),
        )
        .map((node) => node.id);
    }

    function handleSelectAll() {
      onNodesChange(nodes.map((node) => ({ id: node.id, type: "select", selected: true }) as NodeChange<CanvasNode>));
      onEdgesChange(edges.map((edge) => ({ id: edge.id, type: "select", selected: true }) as EdgeChange<CanvasEdge>));
    }

    /**
     * Shared by the native `copy` and `cut` event handlers below: builds the
     * clipboard payload for the current selection and, if there is one,
     * writes it to `event.clipboardData` as this app's JSON envelope (see
     * `clipboard.ts`'s `serializeClipboard`) and calls `preventDefault()` so
     * the browser doesn't also try to copy the empty/irrelevant native DOM
     * selection over it. Returns `false` (and leaves the event alone) when
     * nothing's selected, so a plain-text copy elsewhere on the page — e.g.
     * a label the user actually highlighted — still works normally.
     *
     * Job 013: `buildClipboard` only ever matches ids present in
     * `listNodes` (real ydoc nodes) — an outpost boundary node's id simply
     * won't match anything there, so a selection that includes an outpost
     * silently copies only the real nodes in it. Copying/pasting an outpost
     * itself (with its contents) isn't built here — see
     * jobs/013-outposts.md's Handoff notes for why that's left to
     * Blueprints (Job 026) rather than this job's own clipboard.
     */
    function writeSelectionToClipboard(event: ClipboardEvent): boolean {
      const payload = buildClipboard(sfmDoc, selectedNodeIds());
      if (!payload) return false;
      event.preventDefault();
      event.clipboardData?.setData("text/plain", serializeClipboard(payload));
      return true;
    }

    function handleCopyEvent(event: ClipboardEvent) {
      if (isEditableTarget(event.target)) return;
      writeSelectionToClipboard(event);
    }

    function handleDelete() {
      const edgeIds = selectedEdgeIds();
      deleteSelection(sfmDoc, selectedRealNodeIds(), edgeIds);
      // Job 013: Delete on a selected outpost reparents its contents to
      // this outpost's own parent (never destroys them) — same "delete key
      // acts on whatever's selected" expectation as real nodes/edges above,
      // just routed through `deleteOutpost` instead of `deleteSelection`
      // (see `outposts/reparent.ts`). Each call is its own transaction/undo
      // step, same as `NodeContextMenu`'s "Delete outpost" menu item uses.
      for (const outpostId of selectedOutpostIds()) {
        deleteOutpost(sfmDoc, outpostId);
      }
    }

    function handleCutEvent(event: ClipboardEvent) {
      if (isEditableTarget(event.target)) return;
      if (writeSelectionToClipboard(event)) handleDelete();
    }

    function handlePasteEvent(event: ClipboardEvent) {
      if (isEditableTarget(event.target)) return;
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      const clipboard = deserializeClipboard(text);
      // Not this app's clipboard format (plain text, something copied from
      // elsewhere, a foreign JSON blob) — leave it alone entirely so the
      // browser's own default paste behavior (if any, for whatever has
      // focus) still applies.
      if (!clipboard) return;
      event.preventDefault();
      // Deselect whatever was selected before the paste and select the
      // newly-pasted group instead — the conventional "paste replaces
      // selection with what you just pasted" behavior, and also what makes
      // an immediate follow-up drag/delete act on the new group rather than
      // the old one.
      const previousNodeIds = selectedNodeIds();
      const previousEdgeIds = selectedEdgeIds();
      const offset = pasteOffsetForCenter(clipboard.nodes, getPasteCenter ? getPasteCenter() : null);
      const result = pasteClipboard(sfmDoc, containerId, clipboard, offset);
      // `onNodesChange`/`onEdgesChange` (see `useYjsSync.ts`) resolve
      // against the *live* Zustand store at call time, not against this
      // closure's `nodes`/`edges` — which matters here specifically because
      // `pasteClipboard` just mutated the doc, and that mutation's
      // `observeDeep` resync has already run (synchronously, inside
      // `pasteClipboard`'s own `transact()` call) by the time this line
      // runs, so the newly-pasted ids already exist in the store even
      // though they're not yet in this stale `nodes`/`edges` array. Only
      // listing the ids that need to *change* (not a full current-array
      // map, like `handleSelectAll` above uses) avoids depending on that
      // freshness at all.
      const nodeChanges: NodeChange<CanvasNode>[] = [
        ...previousNodeIds.map((id) => ({ id, type: "select", selected: false }) as NodeChange<CanvasNode>),
        ...result.nodeIds.map((id) => ({ id, type: "select", selected: true }) as NodeChange<CanvasNode>),
      ];
      const edgeChanges: EdgeChange<CanvasEdge>[] = [
        ...previousEdgeIds.map((id) => ({ id, type: "select", selected: false }) as EdgeChange<CanvasEdge>),
        ...result.edgeIds.map((id) => ({ id, type: "select", selected: true }) as EdgeChange<CanvasEdge>),
      ];
      onNodesChange(nodeChanges);
      onEdgesChange(edgeChanges);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (meta && key === "z") {
        event.preventDefault();
        if (event.shiftKey) undoManager.redo();
        else undoManager.undo();
        return;
      }
      if (meta && key === "y") {
        event.preventDefault();
        undoManager.redo();
        return;
      }
      if (meta && key === "a") {
        event.preventDefault();
        handleSelectAll();
        return;
      }
      // Copy/cut/paste are handled by the native `copy`/`cut`/`paste`
      // listeners below instead of here — Ctrl/Cmd+C/X/V already trigger
      // those `ClipboardEvent`s on their own, and handling them there (with
      // access to `event.clipboardData`) is what makes this a real system-
      // clipboard read/write instead of in-memory-only state.
      if (!meta && (key === "delete" || key === "backspace")) {
        event.preventDefault();
        handleDelete();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("copy", handleCopyEvent);
    document.addEventListener("cut", handleCutEvent);
    document.addEventListener("paste", handlePasteEvent);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("copy", handleCopyEvent);
      document.removeEventListener("cut", handleCutEvent);
      document.removeEventListener("paste", handlePasteEvent);
    };
  }, [sfmDoc, containerId, nodes, edges, onNodesChange, onEdgesChange, undoManager, enabled, getPasteCenter]);
}
