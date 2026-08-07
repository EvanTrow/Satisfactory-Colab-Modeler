// Job 022: wires `@scm/ydoc`'s integrity reducer into the client's local
// transaction pipeline — PLAN.md §5's "run after every transaction... on
// both client and server" (the server half lives in
// `apps/realtime/src/server.ts`; see that file's header comment for the
// matching wiring there).
//
// `Y.Doc`'s own `afterTransaction` event is the hook: it fires once per
// completed transaction (local edits from this tab's own UI, `y-indexeddb`
// applying the cached snapshot on load, and `HocuspocusProvider` applying a
// remote peer's sync/update messages all go through the same event — there
// is no separate "was this local or remote" signal `Y.Doc` exposes, nor
// does this need one: PLAN.md §5 says "every transaction," not "every local
// transaction," and repairing promptly after merging in a remote peer's
// edit is strictly more useful than waiting for that peer's own client (or
// the server) to eventually do it and echo the fix back down).
//
// Recursion guard: `runIntegrityReducer` itself runs inside a transaction
// tagged `INTEGRITY_ORIGIN` (`undo.ts`'s `runAsIntegrity`), which also fires
// its own `afterTransaction` — skipping exactly that one origin is what
// stops this from looping forever. This is the same "call `doc.transact`
// again from inside an `afterTransaction` handler" pattern Yjs's own
// `Y.UndoManager` uses internally, not a novel/fragile trick.
import * as Y from "yjs";

import { INTEGRITY_ORIGIN, runIntegrityReducer, type SfmDocument } from "@scm/ydoc";

/**
 * Attaches the ongoing "repair after every transaction" listener and
 * returns a cleanup function to detach it. Does **not** run an initial
 * repair pass itself — call `runIntegrityReducer(sfmDoc)` once up front
 * (e.g. right after hydration, mirroring `apps/realtime`'s "repair on
 * load") for a document that might already be corrupt before this attaches.
 */
export function attachClientIntegrityReducer(sfmDoc: SfmDocument): () => void {
  const handleAfterTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin === INTEGRITY_ORIGIN) return;
    runIntegrityReducer(sfmDoc);
  };

  sfmDoc.doc.on("afterTransaction", handleAfterTransaction);
  return () => sfmDoc.doc.off("afterTransaction", handleAfterTransaction);
}
