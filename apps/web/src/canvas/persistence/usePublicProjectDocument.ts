// Public-link work: the anonymous-viewer sibling of `useProjectDocument.ts`
// — loads (and keeps live-syncing) a project's CRDT document for a visitor
// with no session at all, keyed by the project's public-link `shortId`
// instead of `(projectId, role)`. Structurally closer to
// `useLocalOnlyProjectDocument.ts` than to the real cloud hook: no
// IndexedDB fast-path (a random anonymous visitor gains nothing from a
// persisted local cache of a project they don't own, and skipping it avoids
// ever writing that project's content into this browser's storage at all),
// so this always waits for the provider's first real sync before rendering
// anything — same "no cache to fall back on" slow path
// `useProjectDocument.ts` already has for a brand-new project.
//
// Role is never a parameter here: the server always re-verifies (and
// enforces, via `connectionConfig.readOnly`) `"viewer"` for a public guest
// ticket regardless of what this client asks for — see
// `apps/realtime/src/server.ts`'s `onAuthenticate` and `@scm/doc-storage`'s
// `resolveRole` doc comment.
import { useEffect, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { isNoopRepair } from "@scm/ydoc";

import { captureIntegrityRepairSignal } from "../../monitoring/sentry";
import { bootstrapSfmDocument } from "./bootstrapDocument";
import { attachClientIntegrityReducer } from "./clientIntegrity";
import { computeConnectionStatus, type ConnectionStatus } from "./connectionStatus";
import { fetchPublicRealtimeTicket, getRealtimeWsUrl, previewPublicProject } from "./realtimeTicket";
import type { StaticCanvasDoc } from "./useProjectDocument";

export type PublicProjectDocumentState =
  | { status: "loading" }
  /** No such `shortId`, or the project exists but link-sharing is currently off — deliberately indistinguishable, see `previewPublicProject`'s own doc comment. */
  | { status: "not_shared" }
  | { status: "error"; message: string; retry: () => void }
  | ({ status: "ready"; projectTitle: string } & StaticCanvasDoc);

/**
 * Loads (and keeps live-syncing) the CRDT document for a project's public
 * link. One doc load per `shortId` change.
 */
export function usePublicProjectDocument(
  shortId: string,
): PublicProjectDocumentState & { connectionStatus: ConnectionStatus } {
  const [state, setState] = useState<PublicProjectDocumentState>({ status: "loading" });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    computeConnectionStatus("connecting", navigator.onLine),
  );
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let doc: Y.Doc | null = null;
    let provider: HocuspocusProvider | null = null;
    let wsStatus: "connecting" | "connected" | "disconnected" = "connecting";
    let browserOnline = navigator.onLine;
    let detachIntegrityReducer: (() => void) | null = null;

    setState({ status: "loading" });
    setConnectionStatus(computeConnectionStatus("connecting", browserOnline));

    function refreshConnectionStatus() {
      setConnectionStatus(computeConnectionStatus(wsStatus, browserOnline));
    }
    function handleBrowserOnline() {
      browserOnline = true;
      refreshConnectionStatus();
    }
    function handleBrowserOffline() {
      browserOnline = false;
      refreshConnectionStatus();
    }
    window.addEventListener("online", handleBrowserOnline);
    window.addEventListener("offline", handleBrowserOffline);

    async function load() {
      const preview = await previewPublicProject(shortId);
      if (cancelled) return;
      if (!preview.valid || !preview.projectId || !preview.projectTitle) {
        setState({ status: "not_shared" });
        return;
      }
      const { projectId, projectTitle } = preview;

      doc = new Y.Doc();

      let resolveFirstSync!: () => void;
      let rejectFirstSync!: (err: Error) => void;
      const firstSync = new Promise<void>((resolve, reject) => {
        resolveFirstSync = resolve;
        rejectFirstSync = reject;
      });
      firstSync.catch(() => {});

      provider = new HocuspocusProvider({
        url: getRealtimeWsUrl(),
        name: projectId,
        document: doc,
        token: () => fetchPublicRealtimeTicket(shortId),
        onStatus: ({ status }) => {
          wsStatus = status;
          refreshConnectionStatus();
        },
        onSynced: ({ state: synced }) => {
          if (synced) resolveFirstSync();
        },
        onAuthenticationFailed: ({ reason }) => {
          console.error(`[usePublicProjectDocument] realtime ticket rejected: ${reason}`);
          rejectFirstSync(new Error(`realtime authentication failed: ${reason}`));
        },
      });

      await firstSync;
      if (cancelled || !doc || !provider) return;

      const awareness = provider.awareness;
      if (!awareness) {
        throw new Error("[usePublicProjectDocument] HocuspocusProvider unexpectedly has no awareness instance");
      }

      const { sfmDoc, rootContainerId, undoManager, initialRepairSummary } = bootstrapSfmDocument(doc);
      if (!isNoopRepair(initialRepairSummary)) {
        captureIntegrityRepairSignal({ phase: "client-repair-on-load", repairSummary: initialRepairSummary });
      }
      detachIntegrityReducer = attachClientIntegrityReducer(sfmDoc);

      setState({ status: "ready", projectTitle, sfmDoc, rootContainerId, undoManager, awareness });
    }

    load().catch((err: unknown) => {
      if (cancelled) return;
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load this project",
        retry: () => setRetryToken((t) => t + 1),
      });
    });

    return () => {
      cancelled = true;
      window.removeEventListener("online", handleBrowserOnline);
      window.removeEventListener("offline", handleBrowserOffline);
      detachIntegrityReducer?.();
      detachIntegrityReducer = null;
      provider?.destroy();
    };
  }, [shortId, retryToken]);

  return { ...state, connectionStatus };
}
