// Job 015 built this against a debounced-REST push/pull transport; Job 016
// layered `y-indexeddb` local caching on top of that. Job 020 replaces the
// *live-sync* transport with a real `@hocuspocus/provider` WebSocket
// connection — the IndexedDB caching layer is untouched (still "render
// instantly from local cache, then reconcile," per PLAN.md's "local
// IndexedDB caching but online-to-edit" decision) since it's a genuinely
// separate, complementary concern from how live edits travel over the
// network.
//
// What changed and what didn't, precisely (see this job's Handoff notes
// for the full reasoning):
//   - GONE: `updateQueue.ts`'s debounced push queue, the `doc.on('update',
//     ...)` listener that fed it, and the `RECONCILE_ORIGIN` sentinel that
//     used to exist purely so that listener didn't mistake "bytes the
//     server just sent us" for "a local edit worth pushing back." None of
//     that hand-rolled origin bookkeeping is needed anymore:
//     `HocuspocusProvider` is a real, well-tested Yjs provider — like
//     `y-indexeddb`, it already tags its own applied updates with its own
//     origin internally, so it and `y-indexeddb` coexist on the *same*
//     `Y.Doc` correctly with no extra code here to keep them from
//     re-broadcasting each other's writes in a loop.
//   - GONE: the REST fetch-on-open / push-on-edit calls
//     (`docApi.ts`'s old `fetchProjectDoc`/`pushProjectDocUpdate` — removed
//     entirely, see that file's header comment). The provider's sync
//     protocol replaces both: connecting performs the initial load,
//     and any local `Y.Doc` mutation is synced automatically for as long as
//     the provider stays connected.
//   - UNCHANGED: the IndexedDB fast-path shape (`hasRootContainer` check,
//     "only skip creating a root if the cache already has one"), and the
//     hydration ordering this file has been careful about since Job
//     015/016 — see `finishHydration`'s own comment below for why it still
//     matters, in a slightly different but analogous form.
//   - CHANGED: `SaveStatus` is now derived from the live WebSocket's own
//     connection/sync state (`HocuspocusProvider`'s `onStatus`/
//     `onUnsyncedChanges` callbacks) instead of the old push queue's
//     pending/in-flight/failed bookkeeping — see `computeSaveStatus` below.
//     The `SaveStatus` *type* itself (`"saved" | "saving" | "offline"`) and
//     `SaveStatusIndicator.tsx`'s rendering of it are both unchanged; only
//     what feeds it changed.
//   - CHANGED: every role (including `"viewer"`) now gets a live provider
//     connection, not just owner/editor. This is a deliberate improvement,
//     not an oversight: a viewer should still *see* other collaborators'
//     live edits even though their own can't persist — the previous
//     REST-transport design never wired live sync for anyone, so this
//     distinction didn't exist yet. What still can't happen for a viewer is
//     writes actually taking effect, and that's now a genuine **server-side**
//     guarantee (`apps/realtime/src/server.ts`'s `onAuthenticate` sets
//     `connectionConfig.readOnly = true` for a re-verified `"viewer"` role,
//     and Hocuspocus itself drops inbound update messages on a `readOnly`
//     connection) — not a client-side "don't bother" convenience like
//     before.
import { useCallback, useEffect, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence, clearDocument } from "y-indexeddb";
import * as Y from "yjs";

import { type SfmDocument, addContainer, createDocument, createUndoManager, listContainers } from "@scm/ydoc";

import type { ProjectRole } from "../../api/projects";
import { fetchRealtimeTicket, getRealtimeWsUrl } from "./realtimeTicket";
import type { SaveStatus } from "./updateQueue";

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

/**
 * The local IndexedDB database name for a project's cached doc — unchanged
 * from Job 016, one fixed name per project forever (see that job's Handoff
 * notes for why a generation-counter scheme was tried and rejected).
 */
function indexedDbName(projectId: string): string {
  return `scm-project-${projectId}`;
}

/** Does this (already IndexedDB-synced) doc already have a root container? A pure, non-mutating read — safe to call before deciding whether `finishHydration` needs to create one. */
function hasRootContainer(doc: Y.Doc): boolean {
  const containers = doc.getMap<Y.Map<unknown>>("containers");
  for (const container of containers.values()) {
    if (container.get("kind") === "root") return true;
  }
  return false;
}

/**
 * Derives the `SaveStatus` the `SaveStatusIndicator` already knows how to
 * render from `HocuspocusProvider`'s own live connection state — replaces
 * `updateQueue.ts`'s push-queue-based version (Job 015/016). `"offline"`
 * whenever the underlying WebSocket isn't actually connected (covers both
 * "still connecting" and "disconnected, will auto-retry" — the provider's
 * own reconnect logic, with a fresh ticket fetched per attempt, is what
 * makes "will auto-retry" true, mirroring `updateQueue.ts`'s old
 * auto-retry-on-failure loop but now built into the library rather than
 * hand-rolled). `"saving"` while connected with unacknowledged local
 * changes still in flight; `"saved"` once the provider reports zero.
 */
function computeSaveStatus(wsStatus: "connecting" | "connected" | "disconnected", unsyncedChanges: number): SaveStatus {
  if (wsStatus !== "connected") return "offline";
  return unsyncedChanges > 0 ? "saving" : "saved";
}

/**
 * Loads (and keeps live-syncing) the CRDT document for `projectId`. One doc
 * load per `(projectId, role)` change — a project switch (or a role change)
 * tears down the old provider/IndexedDB connection and starts fresh,
 * mirroring how `App.tsx` already `key`s `<CanvasView>` by project id.
 */
export function useProjectDocument(
  projectId: string,
  role: ProjectRole,
): ProjectDocumentState & { saveStatus: SaveStatus; reloadAfterRestore: () => void } {
  const [state, setState] = useState<ProjectDocumentState>({ status: "loading" });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [retryToken, setRetryToken] = useState(0);
  // Lets `reloadAfterRestore` (called from outside this effect, by a
  // `VersionPanel` click) reach the *current* IndexedDB provider instance to
  // deterministically close it before deleting its data — see that
  // function's doc comment. Unchanged from Job 016.
  const idbRef = useRef<IndexeddbPersistence | null>(null);

  useEffect(() => {
    let cancelled = false;
    let doc: Y.Doc | null = null;
    let idb: IndexeddbPersistence | null = null;
    let provider: HocuspocusProvider | null = null;
    let hydrated = false;
    let wsStatus: "connecting" | "connected" | "disconnected" = "connecting";
    let unsyncedChanges = 0;

    setState({ status: "loading" });
    setSaveStatus("saved");

    function refreshSaveStatus() {
      setSaveStatus(computeSaveStatus(wsStatus, unsyncedChanges));
    }

    /**
     * Runs exactly once per effect run — either right after the local
     * IndexedDB cache sync (the "fast path": the cache already has a root
     * container, so this device has opened this project before) or after
     * the provider's first successful sync with the server (the only path
     * for a project this device has never cached, including a genuinely
     * brand-new one). See `load()` below for exactly when each happens.
     *
     * The ordering concern Job 015/016 both flagged prominently — "the
     * listener that feeds pushes must attach *before* the
     * root-container-creation mutation, or a brand-new project would mint a
     * fresh root on every reload" — took a different, simpler shape once
     * Hocuspocus owns sync: there's no separate listener to attach at all
     * anymore. `HocuspocusProvider` watches *every* mutation to `doc` for as
     * long as it exists (constructed in `load()`, below, before this
     * function ever runs), and Yjs's sync protocol is a bidirectional
     * state-vector diff, not "whatever happened after a listener was
     * wired" — so a root container created here, whenever this runs
     * relative to the provider's own connection lifecycle, is synced
     * correctly regardless. The one invariant that *does* still matter,
     * unchanged from before, is only creating a root when `hasRootContainer`
     * says there isn't one already — that's what stops two clients (or one
     * client across two reloads) from minting duplicate root containers,
     * and it's enforced by `load()`'s fast-path check below, not by
     * anything in this function.
     */
    function finishHydration() {
      if (hydrated || cancelled || !doc) return;
      hydrated = true;

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

      // Created last, deliberately — see this function's header comment on
      // why (unchanged reasoning from Job 015/016): none of the
      // hydration/default-filling mutations above should show up as an
      // undo step once the user starts pressing Ctrl/Cmd+Z.
      const undoManager = createUndoManager(sfmDoc);

      setState({ status: "ready", sfmDoc, rootContainerId: root.id, undoManager });
    }

    async function load() {
      doc = new Y.Doc();

      // Attach the local cache first — cheap, local, no network round-trip.
      // Unchanged from Job 016.
      idb = new IndexeddbPersistence(indexedDbName(projectId), doc);
      idbRef.current = idb;
      try {
        await idb.whenSynced;
      } catch (err) {
        console.warn("[useProjectDocument] IndexedDB cache unavailable, continuing network-only", err);
      }
      if (cancelled) return;

      // Fast path: this device already has a cached copy of this project
      // with real content — render *now*, before the network connection
      // even finishes its first sync, then keep reconciling live in the
      // background. Unchanged in shape from Job 016; see `finishHydration`'s
      // header comment on why it's still safe with a live provider attached.
      const cameFromCache = hasRootContainer(doc);
      if (cameFromCache) {
        finishHydration();
      }

      let resolveFirstSync!: () => void;
      let rejectFirstSync!: (err: Error) => void;
      const firstSync = new Promise<void>((resolve, reject) => {
        resolveFirstSync = resolve;
        rejectFirstSync = reject;
      });
      // Always attach a handler so an auth failure that happens *after*
      // the fast path already rendered (see below) doesn't surface as an
      // unhandled promise rejection — it's genuinely non-fatal in that case,
      // matching Job 015/016's "already rendering from cache; the network
      // failing just means reconciliation hasn't happened yet" precedent.
      firstSync.catch(() => {});

      provider = new HocuspocusProvider({
        url: getRealtimeWsUrl(),
        name: projectId,
        document: doc,
        // Fetched fresh right before *every* connection attempt (initial
        // connect and every reconnect) — never cached — since a ticket is
        // deliberately only valid for 60 seconds
        // (`apps/api/src/realtime/ticket.ts`). `HocuspocusProvider`'s
        // function form of `token` is exactly what makes this possible: it
        // calls this on each attempt, not once at construction time.
        token: () => fetchRealtimeTicket(projectId),
        onStatus: ({ status }) => {
          wsStatus = status;
          refreshSaveStatus();
        },
        onUnsyncedChanges: ({ number }) => {
          unsyncedChanges = number;
          refreshSaveStatus();
        },
        onSynced: ({ state: synced }) => {
          if (synced) resolveFirstSync();
        },
        onAuthenticationFailed: ({ reason }) => {
          console.error(`[useProjectDocument] realtime ticket rejected: ${reason}`);
          rejectFirstSync(new Error(`realtime authentication failed: ${reason}`));
        },
      });

      if (!cameFromCache) {
        // No cache to fall back on — the same "surface the error state"
        // failure mode Job 015 built for a failed REST fetch, now for a
        // failed initial connection/sync instead.
        await firstSync;
      }
      if (cancelled) return;

      finishHydration(); // no-op if the fast path already ran
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
      // Tears down the WebSocket connection cleanly. Unlike Job 015/016's
      // push queue, there's no separate "flush before disposing" step to
      // worry about here — every prior local mutation was already synced
      // continuously while the provider was connected, not batched up for
      // a final flush at teardown time. `reloadAfterRestore` doesn't need
      // its own ref to this provider the way it does for `idb` below —
      // bumping `retryToken` re-runs this whole effect, whose *own* cleanup
      // (this function) tears down the provider it closed over before
      // `load()` runs again.
      provider?.destroy();
      // Closes the IndexedDB connection (fire-and-forget) — does *not*
      // delete the cached data, which is the whole point of a local cache
      // surviving a remount/reload. Unchanged from Job 016.
      void idb?.destroy();
      if (idbRef.current === idb) {
        idbRef.current = null;
      }
    };
  }, [projectId, role, retryToken]);

  /**
   * Called after a successful restore (`docApi.ts`'s `restoreProjectVersion`,
   * still a plain REST call — see that file's header comment on why
   * versions stay REST-based) to make the live canvas reflect the newly-
   * restored state. Unchanged in *mechanism* from Job 016 — still a full
   * re-hydration (fresh `Y.Doc`, cleared IndexedDB cache, fresh network
   * sync) rather than trying to reconcile the restored bytes into the
   * live doc in place, for the same "a CRDT merge can't express a rollback"
   * reason that job's own doc comment on `restoreProjectVersion` explains.
   *
   * One genuine, documented gap this job did **not** close (out of scope —
   * see this job's Handoff notes): if `apps/realtime`'s in-process
   * `Document` for this project is still loaded (i.e. *any* connection,
   * from any user, is currently open on it), the restore's Postgres-level
   * replace has already happened, but Hocuspocus's `onLoadDocument` only
   * runs once per document *load* — not once per *connection* — so a fresh
   * connection from this same reload will sync against the server's
   * still-in-memory (pre-restore) `Document`, not the just-restored
   * Postgres state, until every connection to that document closes and it
   * unloads naturally. In the common case (this is the only open
   * connection, or restoring happens after everyone else has left), the
   * `provider.destroy()` in this effect's cleanup drops the connection
   * count to zero and the reconnect below correctly picks up the restored
   * state.
   */
  const reloadAfterRestore = useCallback(() => {
    void (async () => {
      await idbRef.current?.destroy();
      await clearDocument(indexedDbName(projectId)).catch((err: unknown) => {
        console.warn("[useProjectDocument] failed to clear stale IndexedDB cache after restore", err);
      });
      setRetryToken((t) => t + 1);
    })();
  }, [projectId]);

  return { ...state, saveStatus, reloadAfterRestore };
}
