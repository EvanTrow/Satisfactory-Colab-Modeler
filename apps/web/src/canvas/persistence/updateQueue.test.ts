import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createUpdateQueue } from "./updateQueue";

/** A small evolving Y.Doc, mirroring how a real `SfmDocument`'s `doc.on('update', ...)` listener produces successive incremental updates. */
function createEditor() {
  const doc = new Y.Doc();
  let priorStateVector = Y.encodeStateVector(doc);
  return {
    doc,
    edit(key: string, value: unknown): Uint8Array {
      doc.transact(() => doc.getMap("meta").set(key, value));
      const update = Y.encodeStateAsUpdate(doc, priorStateVector);
      priorStateVector = Y.encodeStateVector(doc);
      return update;
    },
  };
}

/** Applies a merged update (as produced by a queue's `push` mock call) to a fresh doc, for asserting on merged content. */
function applyToFreshDoc(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createUpdateQueue", () => {
  it("does not call push before the debounce delay elapses", () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000 });

    queue.enqueue(editor.edit("a", 1));
    vi.advanceTimersByTime(999);

    expect(push).not.toHaveBeenCalled();
  });

  it("calls push once, with the update, after the debounce delay", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000 });

    queue.enqueue(editor.edit("a", 1));
    await vi.advanceTimersByTimeAsync(1000);

    expect(push).toHaveBeenCalledTimes(1);
    const doc = applyToFreshDoc(push.mock.calls[0]![0]);
    expect(doc.getMap("meta").get("a")).toBe(1);
  });

  it("merges several updates enqueued within one debounce window into a single push call (one project_doc_updates row per window, not one per edit)", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000 });

    queue.enqueue(editor.edit("a", 1));
    vi.advanceTimersByTime(200);
    queue.enqueue(editor.edit("b", 2));
    vi.advanceTimersByTime(200);
    queue.enqueue(editor.edit("c", 3));

    await vi.advanceTimersByTimeAsync(1000);

    expect(push).toHaveBeenCalledTimes(1);
    const doc = applyToFreshDoc(push.mock.calls[0]![0]);
    expect(doc.getMap("meta").get("a")).toBe(1);
    expect(doc.getMap("meta").get("b")).toBe(2);
    expect(doc.getMap("meta").get("c")).toBe(3);
  });

  it("a single update in the window is pushed as-is, not run through Y.mergeUpdates unnecessarily", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000 });

    const update = editor.edit("solo", true);
    queue.enqueue(update);
    await vi.advanceTimersByTimeAsync(1000);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]![0]).toBe(update);
  });

  it("an edit after a flush starts a fresh debounce window and a second push call", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000 });

    queue.enqueue(editor.edit("a", 1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).toHaveBeenCalledTimes(1);

    queue.enqueue(editor.edit("b", 2));
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("flushNow flushes immediately without waiting for the debounce timer", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 5000 });

    queue.enqueue(editor.edit("a", 1));
    await queue.flushNow();

    expect(push).toHaveBeenCalledTimes(1);
  });

  it("flushNow with nothing pending is a no-op", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const queue = createUpdateQueue({ push, delayMs: 1000 });

    await queue.flushNow();
    expect(push).not.toHaveBeenCalled();
  });

  it("on push failure, the batch is re-queued and retried on the next flush; onError is called", async () => {
    const onError = vi.fn();
    let attempt = 0;
    const push = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 1) return Promise.reject(new Error("network down"));
      return Promise.resolve();
    });
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000, onError });

    const update = editor.edit("a", 1);
    queue.enqueue(update);
    await vi.advanceTimersByTimeAsync(1000);

    expect(push).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // Nothing new enqueued — the failed batch itself must be what's retried
    // (bounding loss to "at most one debounce window," per the job's
    // acceptance criteria — a transient failure shouldn't silently drop the
    // edit).
    await queue.flushNow();
    expect(push).toHaveBeenCalledTimes(2);
    const doc = applyToFreshDoc(push.mock.calls[1]![0]);
    expect(doc.getMap("meta").get("a")).toBe(1);
  });

  it("a re-queued failed batch is merged with newly enqueued updates on the next flush, not pushed as two separate calls", async () => {
    const onError = vi.fn();
    let attempt = 0;
    const push = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 1) return Promise.reject(new Error("network down"));
      return Promise.resolve();
    });
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000, onError });

    queue.enqueue(editor.edit("a", 1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).toHaveBeenCalledTimes(1);

    queue.enqueue(editor.edit("b", 2));
    await vi.advanceTimersByTimeAsync(1000);

    expect(push).toHaveBeenCalledTimes(2);
    const doc = applyToFreshDoc(push.mock.calls[1]![0]);
    expect(doc.getMap("meta").get("a")).toBe(1);
    expect(doc.getMap("meta").get("b")).toBe(2);
  });

  it("dispose cancels a pending debounce timer without flushing", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000 });

    queue.enqueue(editor.edit("a", 1));
    queue.dispose();
    await vi.advanceTimersByTimeAsync(5000);

    expect(push).not.toHaveBeenCalled();
  });

  it("onStatusChange reports saved -> saving -> saved for a successful flush", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const onStatusChange = vi.fn();
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000, onStatusChange });

    expect(queue.getStatus()).toBe("saved");

    queue.enqueue(editor.edit("a", 1));
    expect(queue.getStatus()).toBe("saving");
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("saving");

    await vi.advanceTimersByTimeAsync(1000);

    expect(queue.getStatus()).toBe("saved");
    expect(onStatusChange).toHaveBeenNthCalledWith(2, "saved");
    expect(onStatusChange).toHaveBeenCalledTimes(2); // no redundant re-fires for an unchanged status
  });

  it("onStatusChange reports offline after a failed flush, and the status stays offline (not saving) while a retry is pending", async () => {
    const onError = vi.fn();
    const onStatusChange = vi.fn();
    const push = vi.fn().mockRejectedValue(new Error("network down"));
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000, onError, onStatusChange });

    queue.enqueue(editor.edit("a", 1));
    await vi.advanceTimersByTimeAsync(1000);

    expect(queue.getStatus()).toBe("offline");
    expect(onStatusChange).toHaveBeenLastCalledWith("offline");
  });

  it("auto-retries a failed flush after delayMs with no new edit required, and reports saved again once it succeeds", async () => {
    const onStatusChange = vi.fn();
    let attempt = 0;
    const push = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 1) return Promise.reject(new Error("network down"));
      return Promise.resolve();
    });
    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000, onStatusChange });

    queue.enqueue(editor.edit("a", 1));
    await vi.advanceTimersByTimeAsync(1000); // first attempt — fails
    expect(push).toHaveBeenCalledTimes(1);
    expect(queue.getStatus()).toBe("offline");

    // Nothing new enqueued — the queue itself schedules the retry.
    await vi.advanceTimersByTimeAsync(1000);
    expect(push).toHaveBeenCalledTimes(2);
    expect(queue.getStatus()).toBe("saved");
    expect(onStatusChange).toHaveBeenLastCalledWith("saved");
  });

  it("serializes overlapping flushes — a flushNow call while a push is already in flight waits for it rather than firing a second concurrent push", async () => {
    const push = vi.fn();
    let resolveFirst!: () => void;
    push.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveFirst = resolve)));
    push.mockResolvedValueOnce(undefined);

    const editor = createEditor();
    const queue = createUpdateQueue({ push, delayMs: 1000 });

    queue.enqueue(editor.edit("a", 1));
    const firstFlush = queue.flushNow(); // starts the first (slow) push

    queue.enqueue(editor.edit("b", 2));
    const secondFlush = queue.flushNow(); // should wait for the first, then flush "b" separately

    expect(push).toHaveBeenCalledTimes(1); // second push not started yet — still waiting on the first

    resolveFirst();
    await Promise.all([firstFlush, secondFlush]);

    expect(push).toHaveBeenCalledTimes(2);
  });
});
