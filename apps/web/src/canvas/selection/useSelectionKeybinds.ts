// Standard cut/copy/paste/delete/select-all/undo/redo keybinds (Job 012 —
// PLAN.md §2's "Select" row: "Standard cut/copy/paste/delete keybinds", and
// §3's "per-user undo/redo"). All the actual doc-mutation/id-regeneration
// logic lives in `clipboard.ts` (React-free, independently unit-tested);
// this hook is just the keydown wiring plus an in-memory (not OS)
// clipboard ref — see this job's Handoff notes for why an OS clipboard
// wasn't used.
import { useEffect, useRef } from "react";

import type { SfmDocument } from "@scm/ydoc";
import type { EdgeChange, NodeChange } from "@xyflow/react";
import type * as Y from "yjs";

import type { CanvasEdge, CanvasNode, UseYjsSyncResult } from "../useYjsSync";
import { type ClipboardPayload, buildClipboard, deleteSelection, pasteClipboard } from "./clipboard";

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
}

/** True if `target` is a form control the browser's own text-editing keys (Backspace/Delete/Ctrl+C/etc.) should be left alone for — `RecipeNode.tsx`'s limit/clock fields being the concrete case that matters here: deleting text in one of those must never delete the node underneath it. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Wires cut/copy/paste/delete/select-all/undo/redo to `window` keydown
 * events. Window-level (not a focused-element listener) on purpose, same
 * pattern `RecipeChooser.tsx`'s own Escape-to-close handler already uses —
 * there's no dedicated "canvas has focus" concept in this app yet, and the
 * `enabled` flag plus `isEditableTarget` guard cover the cases that
 * actually matter (a modal open, or a text field focused).
 */
export function useSelectionKeybinds(options: UseSelectionKeybindsOptions): void {
  const { sfmDoc, containerId, nodes, edges, onNodesChange, onEdgesChange, undoManager, enabled } = options;
  const clipboardRef = useRef<ClipboardPayload | null>(null);

  useEffect(() => {
    if (!enabled) return;

    function selectedNodeIds(): string[] {
      return nodes.filter((node) => node.selected).map((node) => node.id);
    }
    function selectedEdgeIds(): string[] {
      return edges.filter((edge) => edge.selected).map((edge) => edge.id);
    }

    function handleSelectAll() {
      onNodesChange(nodes.map((node) => ({ id: node.id, type: "select", selected: true }) as NodeChange<CanvasNode>));
      onEdgesChange(edges.map((edge) => ({ id: edge.id, type: "select", selected: true }) as EdgeChange<CanvasEdge>));
    }

    function handleCopy() {
      const payload = buildClipboard(sfmDoc, selectedNodeIds());
      if (payload) clipboardRef.current = payload;
    }

    function handleDelete() {
      const nodeIds = selectedNodeIds();
      const edgeIds = selectedEdgeIds();
      deleteSelection(sfmDoc, nodeIds, edgeIds);
    }

    function handleCut() {
      handleCopy();
      handleDelete();
    }

    function handlePaste() {
      const clipboard = clipboardRef.current;
      if (!clipboard) return;
      // Deselect whatever was selected before the paste and select the
      // newly-pasted group instead — the conventional "paste replaces
      // selection with what you just pasted" behavior, and also what makes
      // an immediate follow-up drag/delete act on the new group rather than
      // the old one.
      const previousNodeIds = selectedNodeIds();
      const previousEdgeIds = selectedEdgeIds();
      const result = pasteClipboard(sfmDoc, containerId, clipboard);
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
      if (meta && key === "c") {
        event.preventDefault();
        handleCopy();
        return;
      }
      if (meta && key === "x") {
        event.preventDefault();
        handleCut();
        return;
      }
      if (meta && key === "v") {
        event.preventDefault();
        handlePaste();
        return;
      }
      if (!meta && (key === "delete" || key === "backspace")) {
        event.preventDefault();
        handleDelete();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sfmDoc, containerId, nodes, edges, onNodesChange, onEdgesChange, undoManager, enabled]);
}
