// Guest-mode work: the local-only sibling of `useProjectDocument.ts`. Loads
// (and keeps persisting) a guest's Yjs document purely in this browser — no
// `HocuspocusProvider`, no realtime ticket, no `/api/*` call of any kind.
// Shares `bootstrapDocument.ts`'s hydration logic with the real hook so the
// two paths can't drift, and reuses `useProjectDocument.ts`'s own
// `StaticCanvasDoc`/`ProjectDocumentState` shapes so `GuestCanvasView.tsx`
// and `CanvasView.tsx` (`CanvasViewReady`) don't need to know which hook
// produced the document they're rendering.
import { useEffect, useRef, useState } from "react";
import { IndexeddbPersistence, clearDocument } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { attachClientIntegrityReducer } from "./clientIntegrity";
import { bootstrapSfmDocument } from "./bootstrapDocument";
import type { ProjectDocumentState } from "./useProjectDocument";
import type { SaveStatus } from "./updateQueue";

/** How long after the last local doc mutation to report `"saved"` again — an approximation, since `y-indexeddb` persists fire-and-forget with no explicit per-update "flushed" callback to key off instead. */
const SAVE_SETTLE_MS = 400;

function guestIndexedDbName(guestId: string): string {
  return `scm-guest-project-${guestId}`;
}

/**
 * Loads (and keeps persisting to IndexedDB) the CRDT document for a guest
 * project. One doc load per `guestId` change, mirroring
 * `useProjectDocument`'s own per-`projectId` effect lifecycle — a project
 * switch tears down the old IndexedDB connection and starts fresh.
 */
export function useLocalOnlyProjectDocument(guestId: string): ProjectDocumentState & { saveStatus: SaveStatus } {
  const [state, setState] = useState<ProjectDocumentState>({ status: "loading" });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saving");
  const [retryToken, setRetryToken] = useState(0);
  const idbRef = useRef<IndexeddbPersistence | null>(null);

  useEffect(() => {
    let cancelled = false;
    let doc: Y.Doc | null = null;
    let idb: IndexeddbPersistence | null = null;
    let detachIntegrityReducer: (() => void) | null = null;
    let saveSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let handleDocUpdate: (() => void) | null = null;

    setState({ status: "loading" });
    setSaveStatus("saving");

    async function load() {
      doc = new Y.Doc();
      idb = new IndexeddbPersistence(guestIndexedDbName(guestId), doc);
      idbRef.current = idb;
      try {
        await idb.whenSynced;
      } catch (err) {
        console.warn("[useLocalOnlyProjectDocument] IndexedDB unavailable for this guest project", err);
      }
      if (cancelled || !doc) return;

      const { sfmDoc, rootContainerId, undoManager } = bootstrapSfmDocument(doc);
      // `report: false` — guest data never leaves the browser, including as
      // an anonymous Sentry repair signal (see `clientIntegrity.ts`'s
      // `AttachClientIntegrityReducerOptions` doc comment). The repair
      // reducer itself still runs; only the telemetry call is skipped.
      detachIntegrityReducer = attachClientIntegrityReducer(sfmDoc, { report: false });

      // No `HocuspocusProvider` to hand out an `Awareness` instance here —
      // see `collab/awareness.ts`'s `AwarenessHandle` doc comment for why a
      // standalone `y-protocols/awareness` instance is the documented
      // exception for exactly this case. Never gossiped anywhere (no remote
      // peer can ever appear solo/offline); it exists purely so
      // `CanvasDocContextValue`'s shape is satisfied unchanged.
      const awareness = new Awareness(doc);

      // Approximate local save-status: "saving" briefly after any local
      // mutation, settling back to "saved" — see this file's header comment
      // on why this can't be driven by a real "flushed" signal the way the
      // cloud hook's `onUnsyncedChanges` is.
      handleDocUpdate = () => {
        if (cancelled) return;
        setSaveStatus("saving");
        if (saveSettleTimer) clearTimeout(saveSettleTimer);
        saveSettleTimer = setTimeout(() => {
          if (!cancelled) setSaveStatus("saved");
        }, SAVE_SETTLE_MS);
      };
      doc.on("update", handleDocUpdate);

      setSaveStatus("saved");
      setState({ status: "ready", sfmDoc, rootContainerId, undoManager, awareness });
    }

    load().catch((err: unknown) => {
      if (cancelled) return;
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load this guest project",
        retry: () => setRetryToken((t) => t + 1),
      });
    });

    return () => {
      cancelled = true;
      detachIntegrityReducer?.();
      detachIntegrityReducer = null;
      if (saveSettleTimer) clearTimeout(saveSettleTimer);
      if (doc && handleDocUpdate) doc.off("update", handleDocUpdate);
      // Closes the IndexedDB connection (fire-and-forget) — does not delete
      // the cached data, same as `useProjectDocument.ts`'s own cleanup.
      void idb?.destroy();
      if (idbRef.current === idb) {
        idbRef.current = null;
      }
    };
  }, [guestId, retryToken]);

  return { ...state, saveStatus };
}

/** Permanently deletes a guest project's local IndexedDB database — used by `guest/localProjects.ts`'s `deleteProject`. Exported here (not duplicated) since it needs the exact same name this hook itself opens. */
export function deleteLocalOnlyProjectDocument(guestId: string): Promise<void> {
  return clearDocument(guestIndexedDbName(guestId));
}

export { guestIndexedDbName };
