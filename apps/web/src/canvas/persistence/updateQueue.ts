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

export interface CreateUpdateQueueOptions {
  /** Sends one merged update blob to the server. Rejects on network/HTTP failure. */
  push: (update: Uint8Array) => Promise<void>;
  /** How long to wait after the *last* enqueued update before flushing. Job 015's job file suggests ~1-2s. */
  delayMs?: number;
  /** Called (not thrown) when a flush's `push` call fails — the batch is re-queued for the next flush, see `flush` below. */
  onError?: (err: unknown) => void;
}

export interface UpdateQueue {
  /** Adds one Yjs update (raw bytes from a `doc.on('update', ...)` callback) to the pending batch and (re)schedules a flush. */
  enqueue(update: Uint8Array): void;
  /** Cancels any pending debounce timer and flushes immediately. Safe to call with nothing pending (no-op). Returns a promise that resolves once the flush (if any) settles. */
  flushNow(): Promise<void>;
  /** Cancels any pending debounce timer without flushing. Does not touch already-in-flight pushes. */
  dispose(): void;
}

const DEFAULT_DELAY_MS = 1500;

export function createUpdateQueue({ push, delayMs = DEFAULT_DELAY_MS, onError }: CreateUpdateQueueOptions): UpdateQueue {
  let pending: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Serializes flushes: a `push` call already in flight is awaited before a
  // second one starts, so two overlapping POSTs (and thus two
  // `project_doc_updates` rows in a fussy interleaved order) can't happen
  // from this queue alone.
  let inFlight: Promise<void> | null = null;

  function scheduleFlush(): void {
    if (timer !== null) return;
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
      } catch (err) {
        // Put the batch back (ahead of anything enqueued meanwhile) so the
        // next flush retries it — this is the mechanism that bounds data
        // loss to "at most one debounce window" even across a transient
        // network failure, not just a hard crash: nothing is dropped until
        // the tab actually closes with a pending batch still unflushed.
        pending = [...batch, ...pending];
        onError?.(err);
      }
    };

    inFlight = run().finally(() => {
      inFlight = null;
    });
    await inFlight;
  }

  function enqueue(update: Uint8Array): void {
    pending.push(update);
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
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { enqueue, flushNow, dispose };
}
