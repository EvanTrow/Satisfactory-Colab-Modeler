// Pure debounce/merge logic for pushing local Yjs updates to the server —
// deliberately independent of React/DOM/`fetch` (the `push` function is
// injected) so it's unit-testable with fake timers and a mock `push`,
// per this repo's established pattern of keeping sync-logic-worth-testing
// standalone (see e.g. `canvas/snapToGrid.ts`).
//
// Job 015's job file: "on local changes, debounce (e.g. ~1-2s) and POST the
// incremental update." One `Y.Doc#update` event fires per `doc.transact(...)`
// call — e.g. exactly one for a single `moveNode` — so in the common case
// each debounce window collapses to exactly one small update, satisfying
// the "writes are O(change), not O(document)" acceptance criterion. If
// *several* transactions land inside the same debounce window (e.g. a fast
// sequence of edits, or defaulting meta/settings plus creating a root
// container on a brand-new project's first load), they're merged via
// `Y.mergeUpdates` into a single blob before the one POST for that window —
// still one row in `project_doc_updates`, not one per transaction.
import * as Y from "yjs";

/**
 * Job 016's autosave-indicator state machine — see `SaveStatusIndicator.tsx`
 * for the UI. `"saved"`: nothing pending, nothing in flight, the last
 * attempt (if any) succeeded. `"saving"`: something is enqueued (waiting out
 * the debounce window or actively POSTing) and the last attempt, if there
 * was one, didn't fail. `"offline"`: the most recent flush attempt failed
 * and hasn't yet been retried successfully — the queue keeps auto-retrying
 * every `delayMs` (see `scheduleFlush` in the `catch` branch below) until it
 * either succeeds or `dispose()` is called, so this state is a live,
 * accurate "still trying to reconnect," not a one-shot failure flag.
 */
export type SaveStatus = "saved" | "saving" | "offline";

export interface CreateUpdateQueueOptions {
  /** Sends one merged update blob to the server. Rejects on network/HTTP failure. */
  push: (update: Uint8Array) => Promise<void>;
  /** How long to wait after the *last* enqueued update before flushing. Job 015's job file suggests ~1-2s. Also reused as the auto-retry interval after a failed flush (Job 016). */
  delayMs?: number;
  /** Called (not thrown) when a flush's `push` call fails — the batch is re-queued for the next flush, see `flush` below. */
  onError?: (err: unknown) => void;
  /** Called synchronously whenever the queue's aggregate `SaveStatus` changes (Job 016). Purely observational — never affects queue behavior. */
  onStatusChange?: (status: SaveStatus) => void;
}

export interface UpdateQueue {
  /** Adds one Yjs update (raw bytes from a `doc.on('update', ...)` callback) to the pending batch and (re)schedules a flush. */
  enqueue(update: Uint8Array): void;
  /** Cancels any pending debounce timer and flushes immediately. Safe to call with nothing pending (no-op). Returns a promise that resolves once the flush (if any) settles. */
  flushNow(): Promise<void>;
  /** Cancels any pending debounce timer without flushing. Does not touch already-in-flight pushes. Does not cancel a scheduled auto-retry-after-failure timer — see `dispose`'s own comment. */
  dispose(): void;
  /** The queue's current aggregate save status — a synchronous read, for a consumer's initial render before the first `onStatusChange` call (which only fires on a *change*). */
  getStatus(): SaveStatus;
}

const DEFAULT_DELAY_MS = 1500;

export function createUpdateQueue({
  push,
  delayMs = DEFAULT_DELAY_MS,
  onError,
  onStatusChange,
}: CreateUpdateQueueOptions): UpdateQueue {
  let pending: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Serializes flushes: a `push` call already in flight is awaited before a
  // second one starts, so two overlapping POSTs (and thus two
  // `project_doc_updates` rows in a fussy interleaved order) can't happen
  // from this queue alone.
  let inFlight: Promise<void> | null = null;
  // Sticky until a flush actually succeeds — "offline" takes precedence
  // over "saving" even while `pending.length > 0` during a retry wait, so
  // the indicator doesn't flicker back to "Saving…" between retries.
  let lastAttemptFailed = false;
  let disposed = false;
  let status: SaveStatus = "saved";

  function computeStatus(): SaveStatus {
    if (lastAttemptFailed) return "offline";
    if (pending.length > 0 || inFlight) return "saving";
    return "saved";
  }

  function refreshStatus(): void {
    const next = computeStatus();
    if (next === status) return;
    status = next;
    onStatusChange?.(status);
  }

  function scheduleFlush(): void {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  }

  async function flush(): Promise<void> {
    if (inFlight) {
      await inFlight;
      // More updates may have queued up while we were waiting on the prior
      // flush (including ones added by a concurrent `flushNow` caller) —
      // drain those too rather than leaving them for the next debounce tick.
      if (pending.length > 0) {
        await flush();
      }
      return;
    }
    if (pending.length === 0) return;

    const batch = pending;
    pending = [];

    const run = async () => {
      try {
        const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
        await push(merged);
        lastAttemptFailed = false;
      } catch (err) {
        // Put the batch back (ahead of anything enqueued meanwhile) so the
        // next flush retries it — this is the mechanism that bounds data
        // loss to "at most one debounce window" even across a transient
        // network failure, not just a hard crash: nothing is dropped until
        // the tab actually closes with a pending batch still unflushed.
        pending = [...batch, ...pending];
        lastAttemptFailed = true;
        onError?.(err);
        // Job 016: without this, a failed flush with nothing further
        // enqueued would sit forever — the original (Job 015) queue only
        // ever scheduled a flush from `enqueue()`, so "Offline —
        // reconnecting" would be a lie unless the user happened to make
        // another edit meanwhile. Retrying on the same cadence as the
        // debounce delay keeps this simple (no separate backoff schedule)
        // while making the indicator's "reconnecting" claim actually true.
        scheduleFlush();
      }
    };

    inFlight = run().finally(() => {
      // Deliberately refreshed *after* `inFlight` is nulled out (not inside
      // `run()` itself) — `computeStatus()` checks `inFlight`, and it's
      // still the not-yet-settled promise for the remainder of `run()`'s own
      // body (the `.finally` callback only runs once that promise actually
      // resolves), so refreshing any earlier would see a stale "still in
      // flight" read even after a successful push already landed.
      inFlight = null;
      refreshStatus();
    });
    refreshStatus(); // reflect "saving" immediately once an attempt starts
    await inFlight;
  }

  function enqueue(update: Uint8Array): void {
    pending.push(update);
    refreshStatus();
    scheduleFlush();
  }

  function flushNow(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return flush();
  }

  function dispose(): void {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function getStatus(): SaveStatus {
    return status;
  }

  return { enqueue, flushNow, dispose, getStatus };
}
