// Job 021: publishes *this* client's own Awareness state and hands back the
// three setters everything else in the canvas needs to keep it live —
// `setCursor` (mousemove, `CanvasView.tsx`'s `CanvasFlow`), `setSelection`
// (React Flow selection changes, same place), and `setEditingField` (focus/
// blur of a limit/clock/shards input, `RecipeNode.tsx`). Mounted once, in
// `CanvasViewReady` (`CanvasView.tsx`), and threaded down through
// `CanvasDocContext` — not remounted per-node or per-panel.
import { useCallback, useEffect, useMemo } from "react";

import {
  createLocalAwarenessState,
  type AwarenessCursor,
  type AwarenessEditingField,
  type AwarenessHandle,
  type LocalUserIdentity,
} from "./awareness";

export interface LocalPresenceControls {
  setCursor: (cursor: AwarenessCursor | null) => void;
  setSelection: (nodeIds: string[]) => void;
  setEditingField: (field: AwarenessEditingField | null) => void;
}

export function useLocalPresence(awareness: AwarenessHandle, user: LocalUserIdentity): LocalPresenceControls {
  useEffect(() => {
    // A full `setLocalState` (not three separate `setLocalStateField` calls)
    // so a peer never observes a half-published state (e.g. `userId` set but
    // `color` still `undefined`) — Awareness's own wire protocol applies a
    // `setLocalState` as one atomic per-client state replacement.
    awareness.setLocalState(createLocalAwarenessState(user));
    // No cleanup call here to explicitly "unpublish" on unmount — genuinely
    // unnecessary, not an oversight: `useProjectDocument.ts`'s own effect
    // cleanup calls `provider.destroy()`, which closes the underlying
    // WebSocket; the *server* is what actually clears this client's
    // Awareness entry for every other peer (`@hocuspocus/server`'s
    // `Document.removeConnection` calls `removeAwarenessStates` the moment
    // it notices the socket close — confirmed by reading its compiled
    // source, and exercised end-to-end by
    // `apps/realtime/src/presence.test.ts`'s disconnect-cleanup test). A
    // client-side "unpublish" call here would race the same teardown for no
    // benefit.
  }, [awareness, user.id, user.displayName, user.avatarUrl]);

  const setCursor = useCallback(
    (cursor: AwarenessCursor | null) => awareness.setLocalStateField("cursor", cursor),
    [awareness],
  );
  const setSelection = useCallback(
    (nodeIds: string[]) => awareness.setLocalStateField("selection", nodeIds),
    [awareness],
  );
  const setEditingField = useCallback(
    (field: AwarenessEditingField | null) => awareness.setLocalStateField("editingField", field),
    [awareness],
  );

  // Memoized (not a fresh object literal every render) so `CanvasView.tsx`'s
  // `docContext` — which lists this hook's return value as one of its own
  // `useMemo` dependencies — doesn't see a "changed" value (and therefore
  // re-render every `CanvasDocContext` consumer) on every unrelated
  // `CanvasViewReady` render. Stable as long as `awareness` identity itself
  // is (one `HocuspocusProvider`/`Awareness` per document mount — see
  // `useProjectDocument.ts`).
  return useMemo(() => ({ setCursor, setSelection, setEditingField }), [setCursor, setSelection, setEditingField]);
}
