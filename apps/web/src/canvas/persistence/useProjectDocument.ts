// Job 015: replaces `CanvasView.tsx`'s old `createLocalCanvasDocument`
// (Job 008) — "creates a brand-new, empty, in-memory `SfmDocument` on every
// mount, no fetch, no persistence" — with the real thing: fetch the
// project's persisted doc bytes, `Y.applyUpdate` them into a fresh `Y.Doc`
// *before* `useYjsSync`'s observers ever attach (so the first paint already
// reflects persisted state, not an empty-then-fill flash), then keep pushing
// local edits back via a debounced queue.
import { useEffect, useState } from "react";
import * as Y from "yjs";

import { type SfmDocument, addContainer, createDocument, createUndoManager, listContainers } from "@scm/ydoc";

import type { ProjectRole } from "../../api/projects";
import { fetchProjectDoc, pushProjectDocUpdate } from "./docApi";
import { createUpdateQueue, type UpdateQueue } from "./updateQueue";

/** The pieces of a hydrated document a `CanvasView` mount needs, once loading has finished. */
export interface StaticCanvasDoc {
  sfmDoc: SfmDocument;
  rootContainerId: string;
  undoManager: Y.UndoManager;
}

export type ProjectDocumentState =
  | { status: "loading" }
  | { status: "error"; message: string; retry: () => void }
  | ({ status: "ready" } & StaticCanvasDoc);

const DEBOUNCE_MS = 1500;

/**
 * Loads (and keeps saving) the CRDT document for `projectId`. One doc load
 * per `(projectId, role)` change — a project switch (or a role change, e.g.
 * a share invite accepted mid-session) tears down the old queue/listener and
 * starts a fresh load, mirroring how `App.tsx` already `key`s `<CanvasView>`
 * by project id so a project switch remounts it entirely.
 *
 * `role === "viewer"` skips wiring the push queue entirely (see the effect
 * body) — a judgement call flagged in this job's Handoff notes: `apps/api`
 * already rejects a viewer's push with 403, so this is purely to avoid
 * generating doomed requests and noisy console errors, not the actual
 * enforcement boundary. It does not stop a viewer from *locally* editing
 * the in-memory doc — building real read-only canvas UI is explicitly
 * deferred to Job 020 per this job's own notes.
 */
export function useProjectDocument(projectId: string, role: ProjectRole): ProjectDocumentState {
  const [state, setState] = useState<ProjectDocumentState>({ status: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let doc: Y.Doc | null = null;
    let queue: UpdateQueue | null = null;
    let updateHandler: ((update: Uint8Array) => void) | null = null;

    setState({ status: "loading" });

    async function load() {
      const bytes = await fetchProjectDoc(projectId);
      if (cancelled) return;

      doc = new Y.Doc();
      if (bytes.length > 0) {
        Y.applyUpdate(doc, bytes);
      }

      // Start capturing local updates *before* any mutation this hook
      // itself makes below (filling default meta/settings, creating a root
      // container for a brand-new project) — so those mutations get pushed
      // to the server too. Without this, a brand-new project would mint a
      // new root-container id on every single reload until the user made
      // their first real edit (nothing would ever persist the very first
      // `addContainer` call below).
      const canPush = role === "owner" || role === "editor";
      if (canPush) {
        queue = createUpdateQueue({
          push: (update) => pushProjectDocUpdate(projectId, update),
          delayMs: DEBOUNCE_MS,
          onError: (err) => {
            // Deliberately not surfaced as a blocking UI error — a transient
            // network failure retries on the next debounce tick (see
            // updateQueue.ts's `flush`), and Job 016 owns the user-visible
            // autosave-status indicator (this job's scope is durability,
            // not that UI).
            console.error("[useProjectDocument] failed to push a doc update, will retry", err);
          },
        });
        updateHandler = (update: Uint8Array) => queue!.enqueue(update);
        doc.on("update", updateHandler);
      }

      const sfmDoc = createDocument({ doc });

      let root = listContainers(sfmDoc).find((container) => container.kind === "root");
      if (!root) {
        root = addContainer(sfmDoc, {
          kind: "root",
          parentId: null,
          title: "Root",
          color: "#4b5563",
          x: 0,
          y: 0,
          copiesLimit: null,
        });
      }

      // Created last, deliberately — see this function's header comment.
      // None of the hydration/default-filling mutations above should show
      // up as an undo step once the user starts pressing Ctrl/Cmd+Z.
      const undoManager = createUndoManager(sfmDoc);

      if (cancelled) return;
      setState({ status: "ready", sfmDoc, rootContainerId: root.id, undoManager });
    }

    load().catch((err: unknown) => {
      if (cancelled) return;
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load the project",
        retry: () => setRetryToken((t) => t + 1),
      });
    });

    return () => {
      cancelled = true;
      if (doc && updateHandler) {
        doc.off("update", updateHandler);
      }
      if (queue) {
        // Best-effort final flush on unmount (navigating back to the
        // project list, switching projects): a deliberate navigation
        // shouldn't lose an edit still sitting in the debounce window just
        // because nothing was going to flush it otherwise. This is
        // fire-and-forget — React doesn't wait on an effect cleanup
        // function's returned promise — but it's still strictly better than
        // not trying. A genuine crash/tab-close skips this entirely, which
        // is exactly the "loses at most one debounce window" acceptance
        // criterion this job targets, not a gap to close here.
        void queue.flushNow();
        queue.dispose();
      }
    };
  }, [projectId, role, retryToken]);

  return state;
}
