// Job 021: the one shared subscription mechanism every remote-presence UI
// piece (`PresenceCursors.tsx`, `PresenceAvatarList.tsx`, `RecipeNode.tsx`'s
// selection halo + field indicators) reads from — each calls this hook
// itself (rather than one shared value being baked into `CanvasDocContext`)
// so a high-frequency change (a peer's cursor moving) only re-renders the
// specific components that actually read presence, not every consumer of
// the wider canvas doc context (`sfmDoc`/`undoManager`/...) on every mouse
// move anywhere on anyone's screen.
//
// Not unit-tested directly (this repo's `apps/web` test infra is
// node-environment-only, no React DOM/`renderHook` — see this file's sibling
// `awareness.ts`'s header comment on the "extract pure logic, leave the hook
// itself untested" convention every canvas job since 009 has followed) —
// the actual validation logic it depends on (`parseAwarenessState`) is fully
// covered in `awareness.test.ts`, and the live end-to-end behavior (does a
// change on one client actually show up here on another) is covered by
// `apps/realtime/src/presence.test.ts`'s real two-provider tests, which
// exercise the exact same `Awareness.getStates()`/`"change"` event contract
// this hook is built on.
import { useEffect, useState } from "react";

import { parseAwarenessState, type AwarenessHandle, type AwarenessState } from "./awareness";

export interface RemotePresence {
  /** The remote peer's Yjs client id (`Awareness`'s own connection-scoped identifier) — stable for the lifetime of one connection, not the same thing as `state.userId` (a real user reconnecting gets a fresh `clientId` but the same `userId`). Used as React's `key` for presence-derived UI. */
  clientId: number;
  state: AwarenessState;
}

/**
 * Every *other* client's live Awareness state, re-read on every
 * `Awareness#"change"` event. Always excludes this client's own entry
 * (`awareness.clientID`) — every consumer only ever wants "who else is
 * here," never a reflection of its own just-published state. An entry whose
 * raw state doesn't pass `parseAwarenessState` (a peer that's connected but
 * hasn't published its own local state yet, or ever) is silently omitted,
 * not rendered as a broken/partial presence.
 */
export function useRemotePresence(awareness: AwarenessHandle): RemotePresence[] {
  const [remotes, setRemotes] = useState<RemotePresence[]>(() => readRemotePresence(awareness));

  useEffect(() => {
    const sync = () => setRemotes(readRemotePresence(awareness));
    sync(); // `awareness` identity can change (a project switch tears down the old provider) — resync immediately rather than waiting for the next remote change.
    awareness.on("change", sync);
    return () => awareness.off("change", sync);
  }, [awareness]);

  return remotes;
}

function readRemotePresence(awareness: AwarenessHandle): RemotePresence[] {
  const result: RemotePresence[] = [];
  awareness.getStates().forEach((raw, clientId) => {
    if (clientId === awareness.clientID) return;
    const state = parseAwarenessState(raw);
    if (state) result.push({ clientId, state });
  });
  return result;
}
