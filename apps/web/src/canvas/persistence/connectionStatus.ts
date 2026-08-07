// Job 022: connection-status UI — PLAN.md §5's "connection-status UI" bullet
// and this job's own deliverable, "a visible indicator for connected /
// reconnecting / offline state on the live WebSocket connection."
//
// This is deliberately a DIFFERENT signal from `updateQueue.ts`'s
// `SaveStatus` ("saved"/"saving"/"offline"), even though both are ultimately
// sourced from the same `HocuspocusProvider` instance in
// `useProjectDocument.ts`. `SaveStatus` answers "are my edits safely on the
// server" (a save/sync-durability question — its own "offline" already
// covers "the socket isn't connected right now" as one of several reasons
// edits might not be flushed). `ConnectionStatus` answers a narrower,
// purely transport-level question: "is the live WebSocket itself up right
// now, and if not, is it actively retrying or is there no network at all."
// Kept as a second, distinct indicator in the UI (`ConnectionStatusIndicator
// .tsx`) rather than folded into `SaveStatusIndicator.tsx`, since collapsing
// them would lose real information — e.g. a viewer (whose edits never push
// at all, so `SaveStatusIndicator` always reads "View only") still very much
// cares whether their live view of collaborators' edits is currently
// connected.
export type ConnectionStatus = "connected" | "reconnecting" | "offline";

/**
 * Derives `ConnectionStatus` from the provider's raw `onStatus` value plus
 * the browser's own network signal (`navigator.onLine`). `HocuspocusProvider`
 * retries indefinitely on its own (see `useProjectDocument.ts`'s header
 * comment on `SaveStatus`'s "offline" case) — there is no distinct "gave up
 * retrying" state to surface — so "reconnecting" covers every
 * not-currently-connected case where the browser still has a network path
 * at all (including the very first connect attempt, before anything has
 * ever succeeded — there's no meaningful UI difference between "connecting
 * for the first time" and "reconnecting after a drop" from the user's point
 * of view, both read as transient/in-progress). "offline" is reserved for
 * the case the browser itself reports no network — the one case where
 * "retrying won't help right now" is actually true.
 */
export function computeConnectionStatus(
  wsStatus: "connecting" | "connected" | "disconnected",
  browserOnline: boolean,
): ConnectionStatus {
  if (!browserOnline) return "offline";
  return wsStatus === "connected" ? "connected" : "reconnecting";
}
