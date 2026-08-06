// Job 015: replaces `CanvasView.tsx`'s old `createLocalCanvasDocument`
// (Job 008) — "creates a brand-new, empty, in-memory `SfmDocument` on every
// mount, no fetch, no persistence" — with the real thing: fetch the
// project's persisted doc bytes, `Y.applyUpdate` them into a fresh `Y.Doc`
// *before* `useYjsSync`'s observers ever attach (so the first paint already
// reflects persisted state, not an empty-then-fill flash), then keep pushing
// local edits back via a debounced queue.
//
// Job 016 layers two things on top, both scoped by PLAN.md's "local
// IndexedDB caching but online-to-edit" decision:
//   1. `y-indexeddb` (`IndexeddbPersistence`) attached to the same `Y.Doc`,
//      so a *returning* visit to a project already cached on this device can
//      render instantly from the local cache while the network fetch is
//      still in flight, then reconciles once that fetch resolves — see
//      `load()`'s "fast path" below. A brand-new project (or a device that's
//      never cached this project before) has no cache to render from, so it
//      falls through to exactly Job 015's original network-required
//      behavior — the "online-to-edit" decision isn't relaxed, only the
//      *read* path gets an instant-render shortcut for already-cached data.
//   2. `SaveStatus` — the live "Saved" / "Saving…" / "Offline — reconnecting"
//      indicator's state, sourced from `updateQueue.ts`'s own status
//      tracking (see that file's `SaveStatus`/`onStatusChange`).
import { useCallback, useEffect, useRef, useState } from "react";
import { IndexeddbPersistence, clearDocument } from "y-indexeddb";
import * as Y from "yjs";

import { type SfmDocument, addContainer, createDocument, createUndoManager, listContainers } from "@scm/ydoc";

import type { ProjectRole } from "../../api/projects";
import { fetchProjectDoc, pushProjectDocUpdate } from "./docApi";
import { createUpdateQueue, type SaveStatus, type UpdateQueue } from "./updateQueue";

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
 * Marks a `Y.applyUpdate` call as "bytes we already know the server/cache
 * has" (the initial cache load and the network-reconcile apply), so the
 * push-queue's `doc.on('update', ...)` listener can skip re-pushing them
 * back to the server as if they were a fresh local edit — see `finishHydration`'s
 * `updateHandler` below. A local user edit (or this hook's own
 * default-filling/root-creation mutations, which *should* be pushed) never
 * passes an origin, so its origin is `undefined` and is never mistaken for
 * this sentinel. A module-level `Symbol` (not a string) so it can never
 * collide with an origin some other part of the app might pass.
 */
const RECONCILE_ORIGIN = Symbol("scm-doc-reconcile");

/**
 * The local IndexedDB database name for a project's cached doc — one fixed
 * name per project, deliberately never suffixed/versioned. An earlier draft
 * of this file tried a "bump a generation counter on restore, so the next
 * load ignores the stale cache" scheme, keyed by an in-memory `useRef`. That
 * broke the very thing this job requires: a `useRef` resets to its initial
 * value on every remount, including a real browser reload — so the *next*
 * actual page reload after a restore would silently fall back to
 * generation 0's (long-stale, pre-restore) cache instead of the one the
 * restore had just moved to, defeating "reloading shows the cached local
 * state instantly" for exactly the project that just had a restore happen.
 * Fixed by keeping one name per project forever and, on restore,
 * deterministically closing then deleting that database's contents before
 * re-hydrating (see `reloadAfterRestore` below) — the cache is genuinely
 * emptied, not renamed, so a subsequent real reload's fast path is
 * comparing against the *current* (post-restore) name every time.
 */
function indexedDbName(projectId: string): string {
  return `scm-project-${projectId}`;
}

/** Does this (already IndexedDB-synced) doc already have a root container? A pure, non-mutating read — safe to call before deciding whether to attach the push queue (see this file's header comment on why that ordering matters). */
function hasRootContainer(doc: Y.Doc): boolean {
  const containers = doc.getMap<Y.Map<unknown>>("containers");
  for (const container of containers.values()) {
    if (container.get("kind") === "root") return true;
  }
  return false;
}

/**
 * Loads (and keeps saving) the CRDT document for `projectId`. One doc load
 * per `(projectId, role)` change — a project switch (or a role change, e.g.
 * a share invite accepted mid-session) tears down the old queue/listener/
 * IndexedDB provider and starts a fresh load, mirroring how `App.tsx`
 * already `key`s `<CanvasView>` by project id so a project switch remounts
 * it entirely.
 *
 * `role === "viewer"` skips wiring the push queue entirely (see the effect
 * body) — a judgement call flagged in Job 015's Handoff notes: `apps/api`
 * already rejects a viewer's push with 403, so this is purely to avoid
 * generating doomed requests and noisy console errors, not the actual
 * enforcement boundary. It does not stop a viewer from *locally* editing
 * the in-memory doc — building real read-only canvas UI is explicitly
 * deferred to Job 020 per that job's own notes.
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
  // function's doc comment.
  const idbRef = useRef<IndexeddbPersistence | null>(null);

  useEffect(() => {
    let cancelled = false;
    let doc: Y.Doc | null = null;
    let idb: IndexeddbPersistence | null = null;
    let queue: UpdateQueue | null = null;
    let updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
    let hydrated = false;

    setState({ status: "loading" });
    setSaveStatus("saved");

    /**
     * Runs exactly once per effect run, the moment there's enough
     * information to render — either right after the local IndexedDB cache
     * sync (if it already contains a root container, the "fast path") or
     * after the network fetch resolves (the only path for a project this
     * device has never cached, including a genuinely brand-new project).
     *
     * The push-queue listener is attached *before* this function's own
     * `createDocument`/root-ensuring mutations, for exactly the reason Job
     * 015's handoff notes spell out: without that ordering, a brand-new
     * project would mint a new root-container id on every reload until the
     * user's first real edit, since nothing would ever persist the very
     * first `addContainer` call below. That invariant is unaffected by the
     * IndexedDB fast path — the fast path is only ever taken when a root
     * *already exists* (see `hasRootContainer` above), so a genuinely new
     * project always falls through to the slow, network-required path,
     * where this same ordering applies exactly as it did in Job 015.
     */
    function finishHydration() {
      if (hydrated || cancelled || !doc) return;
      hydrated = true;

      const canPush = role === "owner" || role === "editor";
      if (canPush) {
        queue = createUpdateQueue({
          push: (update) => pushProjectDocUpdate(projectId, update),
          delayMs: DEBOUNCE_MS,
          onStatusChange: setSaveStatus,
          onError: (err) => {
            // updateQueue.ts's own retry loop (and onStatusChange -> "offline")
            // handles the user-visible side of this; still worth a console
            // trace for anyone debugging a stuck sync.
            console.error("[useProjectDocument] failed to push a doc update, will retry", err);
          },
        });
        setSaveStatus(queue.getStatus());
        updateHandler = (update: Uint8Array, origin: unknown) => {
          if (origin === RECONCILE_ORIGIN) return;
          queue!.enqueue(update);
        };
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

      setState({ status: "ready", sfmDoc, rootContainerId: root.id, undoManager });
    }

    async function load() {
      doc = new Y.Doc();

      // Attach the local cache first — cheap, local, no network round-trip.
      // `whenSynced` resolves once whatever's already cached for this
      // project (nothing, for a first-ever visit) has been `Y.applyUpdate`-d
      // into `doc` by the library itself (with its own origin, so it's never
      // mistaken for a local edit worth pushing back — see
      // `finishHydration`'s `updateHandler`).
      idb = new IndexeddbPersistence(indexedDbName(projectId), doc);
      idbRef.current = idb;
      try {
        await idb.whenSynced;
      } catch (err) {
        // IndexedDB unavailable (private browsing in some browsers, quota
        // errors, disabled storage) — degrade to exactly Job 015's
        // network-only behavior rather than failing the whole load.
        console.warn("[useProjectDocument] IndexedDB cache unavailable, continuing network-only", err);
      }
      if (cancelled) return;

      // Fast path: this device already has a cached copy of this project
      // with real content — render *now*, before the network fetch even
      // resolves, then keep reconciling with the server in the background.
      // A doc with no root container at all (never cached before, or a
      // genuinely brand-new project) never takes this path — see
      // `finishHydration`'s header comment on why that matters.
      const cameFromCache = hasRootContainer(doc);
      if (cameFromCache) {
        finishHydration();
      }

      let bytes: Uint8Array;
      try {
        bytes = await fetchProjectDoc(projectId);
      } catch (err) {
        if (cancelled) return;
        if (!cameFromCache) {
          // No cache to fall back on and the network fetch failed — this is
          // exactly Job 015's original failure mode, surfaced the same way
          // (the "error" state with a Retry button).
          throw err;
        }
        // Already rendering from cache; the fetch failing here just means
        // reconciliation hasn't happened yet. Not fatal — the canvas stays
        // up, and the save-status indicator (once a push queue exists)
        // already reflects "offline" via its own retry loop; there's
        // nothing further to do here for a role that can't push anyway.
        return;
      }
      if (cancelled) return;

      if (bytes.length > 0) {
        // Tagged as a reconcile apply (not a local edit) — if the push
        // queue is already attached (the fast path), this must not be
        // queued back to the server, or every reload would re-push content
        // the server just sent us.
        Y.applyUpdate(doc, bytes, RECONCILE_ORIGIN);
      }

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
      // Closes the IndexedDB connection (fire-and-forget, mirroring
      // `queue.flushNow()` above) — does *not* delete the cached data, which
      // is the whole point of a local cache surviving a remount/reload.
      // Safe to call even if `reloadAfterRestore` already called `destroy()`
      // on this same instance (idempotent — see that function's doc comment).
      void idb?.destroy();
      if (idbRef.current === idb) {
        idbRef.current = null;
      }
    };
  }, [projectId, role, retryToken]);

  /**
   * Called after a successful restore (`docApi.ts`'s `restoreProjectVersion`)
   * to make the live canvas reflect the newly-restored state. A restore is a
   * *wholesale replace* server-side (see `docStorage.ts`'s own doc comment on
   * why it can't be a `Y.applyUpdate` merge) — for the client to honor that
   * same "unambiguous replace, not merge" semantics, it can't just
   * `Y.applyUpdate` the restored bytes into the *current* live `doc` either:
   * that doc may contain content (e.g. nodes) from the pre-restore state
   * that the restored version never had, and a CRDT merge is fundamentally
   * additive — it has no way to "un-add" them.
   *
   * So this forces a full re-hydration in two steps:
   *   1. Deterministically close the *current* IndexedDB connection
   *      (`idbRef.current.destroy()`, awaited — not fire-and-forget, unlike
   *      the effect cleanup's own best-effort `destroy()` call) and only
   *      then delete that database's contents (`clearDocument`). Sequencing
   *      matters: `indexedDB.deleteDatabase` on a database with an open
   *      connection can block ("blocked" event) until every connection to it
   *      closes, so closing first — rather than racing a delete against the
   *      effect's own async cleanup — avoids that hang entirely.
   *   2. Bump `retryToken`, re-running the effect above from scratch: a
   *      brand-new `Y.Doc`, a fresh `IndexeddbPersistence` against the
   *      *same* database name (now genuinely empty, not just orphaned under
   *      a different name), and a fresh network fetch of the now-restored
   *      server state. Because the name never changes, the *next* real page
   *      reload after this one still finds — and instantly renders from —
   *      the correct (post-restore) cached content, once step 2's network
   *      fetch repopulates it (`IndexeddbPersistence` persists every `doc`
   *      update regardless of origin, including the `RECONCILE_ORIGIN`-
   *      tagged apply of the restored bytes).
   */
  const reloadAfterRestore = useCallback(() => {
    void (async () => {
      await idbRef.current?.destroy();
      await clearDocument(indexedDbName(projectId)).catch((err: unknown) => {
        // Best-effort only. The connection is already closed by this point
        // (the `await` above), so a `deleteDatabase` failure here would be a
        // genuine IndexedDB-level error (quota/permissions/browser quirk),
        // not the "blocked by an open connection" case this two-step
        // sequencing is designed to avoid. If it does fail, the *next*
        // effect run's fast path would briefly re-apply the stale
        // pre-restore content from the untouched cache before the network
        // fetch's `RECONCILE_ORIGIN` apply lands on top of it — a real,
        // if narrow, gap in the "wholesale replace" guarantee for that one
        // reload specifically (not for any reload after it, since the
        // network apply still runs and gets cached going forward). Logged
        // rather than silently swallowed so it's at least visible if it
        // ever happens.
        console.warn("[useProjectDocument] failed to clear stale IndexedDB cache after restore", err);
      });
      setRetryToken((t) => t + 1);
    })();
  }, [projectId]);

  return { ...state, saveStatus, reloadAfterRestore };
}
