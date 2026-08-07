// Job 015 built a debounced-REST push queue here; Job 016 added the
// `SaveStatus` state machine on top of it. Job 020 replaced the *transport*
// (`useProjectDocument.ts` now uses a live `@hocuspocus/provider` WebSocket
// instead of debounced REST pushes — see that file's header comment for the
// full reasoning), which made the actual queue implementation
// (`createUpdateQueue`/`UpdateQueue`, previously exported from this file)
// dead code: nothing merges/debounces/retries pushes by hand anymore,
// since Hocuspocus's own provider syncs every local change continuously
// while connected, with its own built-in reconnect-and-retry. That
// implementation (and its 11-test suite, `updateQueue.test.ts`) was removed
// rather than kept around unused.
//
// `SaveStatus` itself is kept — Job 020 didn't change what the autosave
// indicator communicates to a user, only what feeds it (see
// `useProjectDocument.ts`'s `computeSaveStatus`, which derives this same
// three-state union from `HocuspocusProvider`'s own connection/sync
// callbacks instead of this file's old queue bookkeeping). Kept in this
// file rather than moved, to avoid changing every existing import path
// (`SaveStatusIndicator.tsx`, `CanvasView.tsx`, `useProjectDocument.ts` all
// still `import type { SaveStatus } from "./updateQueue"`).
export type SaveStatus = "saved" | "saving" | "offline";
