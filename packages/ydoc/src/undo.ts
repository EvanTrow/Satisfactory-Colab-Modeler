// `Y.UndoManager` setup — PLAN.md §5's integrity reducer runs "inside a Yjs
// transaction tagged `origin: 'integrity'` so it never pollutes anyone's
// undo stack." The reducer itself is Job 022; this module is where the
// `'integrity'` origin is reserved and where the undo manager is configured
// to exclude it, so the contract exists from day one and Job 022 has
// nothing to configure — it just needs to call `doc.transact(fn,
// INTEGRITY_ORIGIN)` (or the `runAsIntegrity` helper below).
import * as Y from "yjs";
import type { SfmDocument } from "./document.js";

/**
 * The reserved transaction origin for the integrity reducer (Job 022).
 * `createUndoManager` always excludes this origin from tracking, regardless
 * of what `trackedOrigins` a caller passes in — see the note on
 * `trackedOrigins` below.
 */
export const INTEGRITY_ORIGIN = "integrity" as const;

export interface UndoManagerOptions {
  /**
   * Which transaction origins get captured onto the undo stack. Defaults to
   * `new Set([null])` — i.e. only "plain" local transactions (the origin
   * every mutation helper in `mutations.ts` uses unless a caller passes an
   * explicit `origin`). Job 012 (per-user undo) is expected to pass a set
   * scoped to the local user's own origin/session id once multiplayer
   * origins exist. `INTEGRITY_ORIGIN` is removed from this set
   * unconditionally, even if a caller includes it explicitly, so the
   * exclusion can never be accidentally reintroduced.
   */
  trackedOrigins?: Set<unknown>;
  /** Forwarded to `Y.UndoManager` — max ms between edits still coalesced into one undo step. */
  captureTimeout?: number;
}

/**
 * Creates a `Y.UndoManager` scoped to the document's `settings`,
 * `containers`, `nodes`, and `edges` maps (not `meta` — schema/title/game-
 * data-version bookkeeping is not something users "undo" from the canvas).
 *
 * Job 008/012 wiring notes: call `.undo()`/`.redo()` in response to
 * keyboard shortcuts. To drive enabled/disabled undo/redo UI state, listen
 * for the manager's `stack-item-added`/`stack-item-popped`/`stack-cleared`
 * events (or just poll `undoManager.undoStack.length`/`redoStack.length`).
 */
export function createUndoManager(
  sfmDoc: SfmDocument,
  options: UndoManagerOptions = {},
): Y.UndoManager {
  // Cast needed because `Y.AbstractType<T>` is invariant over `T` in its
  // internal event-handler typing, so a `Y.Map<Y.Map<unknown>>[]` (and even
  // a `Y.Map<unknown>[]`) doesn't structurally satisfy
  // `Y.AbstractType<unknown>[]` even though it's exactly what
  // `Y.UndoManager`'s `scope` parameter expects at runtime.
  const scope = [
    sfmDoc.settings,
    sfmDoc.containers,
    sfmDoc.nodes,
    sfmDoc.edges,
  ] as unknown as Array<Y.AbstractType<unknown>>;

  const trackedOrigins = new Set<unknown>(options.trackedOrigins ?? [null]);
  // Defensive even against a caller-supplied set: the integrity origin must
  // never end up trackable.
  trackedOrigins.delete(INTEGRITY_ORIGIN);

  return new Y.UndoManager(scope, {
    trackedOrigins,
    ...(options.captureTimeout !== undefined ? { captureTimeout: options.captureTimeout } : {}),
  });
}

/** Runs `fn` inside a transaction tagged with the reserved integrity origin. */
export function runAsIntegrity(sfmDoc: SfmDocument, fn: () => void): void {
  sfmDoc.doc.transact(fn, INTEGRITY_ORIGIN);
}
