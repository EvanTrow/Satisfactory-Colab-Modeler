// Job 021: the one shared subscription mechanism every remote-presence UI
// piece (`PresenceCursors.tsx`, `PresenceAvatarList.tsx`, `RecipeNode.tsx`'s
// selection halo + field indicators) reads from — each calls this hook
// itself (rather than one shared value being baked into `CanvasDocContext`)
// so a high-frequency change (a peer's cursor moving) only re-renders the
// specific components that actually read presence, not every consumer of
// the wider canvas doc context (`sfmDoc`/`undoManager`/...) on every mouse
// move anywhere on anyone's screen.
//
// `derivePresenceWithFreshness` (below) is unit-tested directly — it's the
// one piece of real logic this file owns, extracted with an injectable
// clock exactly like `throttle.ts`'s own convention. The hook itself stays
// untested (this repo's `apps/web` test infra is node-environment-only, no
// React DOM/`renderHook` — see `awareness.ts`'s header comment on the
// "extract pure logic, leave the hook itself untested" convention every
// canvas job since 009 has followed); the live end-to-end behavior (does a
// change on one client actually show up here on another) is covered by
// `apps/realtime/src/presence.test.ts`'s real two-provider tests, which
// exercise the exact same `Awareness.getStates()`/`"change"` event contract
// this hook is built on.
import { useEffect, useRef, useState } from "react";

import { parseAwarenessState, type AwarenessHandle, type AwarenessState } from "./awareness";

export interface RemotePresence {
  /** The remote peer's Yjs client id (`Awareness`'s own connection-scoped identifier) — stable for the lifetime of one connection, not the same thing as `state.userId` (a real user reconnecting gets a fresh `clientId` but the same `userId`). Used as React's `key` for presence-derived UI. */
  clientId: number;
  state: AwarenessState;
}

/**
 * How long a peer's `dragging`/`edgeDragging` broadcast can go without a
 * fresh sample before this client stops trusting it and falls back to that
 * node/edge's real, persisted position instead. Unlike the Yjs *document*
 * sync channel (guaranteed, eventually-consistent delivery), Awareness is
 * fire-and-forget — a dropped or badly delayed "gesture ended" broadcast
 * (`useDragPublisher.ts`/`useEdgeDragPublisher.ts`'s `clear()`, sent once,
 * never retried) is never resent, so without this a single lost `clear()`
 * leaves a REMOTE peer's canvas overriding that node/edge's position with a
 * frozen stale sample forever — nothing else ever touches that Awareness
 * field again unless the same peer drags that same node/edge a second time.
 * This is what was reported as a moved node's connection, then the node
 * itself, silently vanishing (rendered at its last-dragged-to spot, however
 * far that's since drifted from reality) for a remote viewer until they
 * refreshed the page (a fresh Awareness read has nothing stale to inherit).
 * A live drag publishes at least every `DRAG_PUBLISH_INTERVAL_MS`/
 * `EDGE_DRAG_PUBLISH_INTERVAL_MS` (50ms), so this threshold has an order of
 * magnitude of margin before it could ever cut off a genuinely
 * still-in-progress gesture.
 */
const DRAG_STALE_MS = 500;

/** How often to re-check staleness even with no new Awareness `"change"` event — must be well under `DRAG_STALE_MS` so an expiry is noticed promptly instead of only whenever some unrelated presence field next changes (or never, if this peer stays otherwise idle). */
const STALE_CHECK_INTERVAL_MS = 150;

interface TrackedField {
  /** `JSON.stringify` of the last-observed value (`null` for "no dragging in flight") — cheap value-equality for a payload this small, and simpler than a bespoke deep-equal given `AwarenessDragging`'s nested `nodes`/`waypoints` arrays. */
  signature: string | null;
  /** THIS client's own clock, stamped whenever `signature` last actually changed — never the sender's clock, so two peers' unsynchronized system clocks can never matter here. */
  lastChangedAt: number;
}

export interface TrackedDragEntry {
  dragging: TrackedField;
  edgeDragging: TrackedField;
}

function signatureOf(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function freshField(now: number): TrackedField {
  return { signature: null, lastChangedAt: now };
}

/**
 * Pure, injectable-clock core of the staleness tracking — mutates `tracked`
 * in place (the caller's persistent per-clientId map, carried across ticks)
 * and returns this tick's presence list with any gone-stale `dragging`/
 * `edgeDragging` nulled out (per `DRAG_STALE_MS`'s doc comment above).
 * Extracted from the hook so it's directly unit-testable with a fake clock,
 * matching `throttle.ts`'s identical "injectable `now`" shape.
 */
export function derivePresenceWithFreshness(
  rawStates: Map<number, unknown>,
  selfClientId: number,
  tracked: Map<number, TrackedDragEntry>,
  now: number,
): RemotePresence[] {
  const seen = new Set<number>();
  const result: RemotePresence[] = [];

  rawStates.forEach((raw, clientId) => {
    if (clientId === selfClientId) return;
    const state = parseAwarenessState(raw);
    if (!state) return;
    seen.add(clientId);

    let entry = tracked.get(clientId);
    if (!entry) {
      entry = { dragging: freshField(now), edgeDragging: freshField(now) };
      tracked.set(clientId, entry);
    }

    const draggingSig = signatureOf(state.dragging);
    if (draggingSig !== entry.dragging.signature) {
      entry.dragging = { signature: draggingSig, lastChangedAt: now };
    }
    const edgeDraggingSig = signatureOf(state.edgeDragging);
    if (edgeDraggingSig !== entry.edgeDragging.signature) {
      entry.edgeDragging = { signature: edgeDraggingSig, lastChangedAt: now };
    }

    const draggingStale = state.dragging !== null && now - entry.dragging.lastChangedAt > DRAG_STALE_MS;
    const edgeDraggingStale = state.edgeDragging !== null && now - entry.edgeDragging.lastChangedAt > DRAG_STALE_MS;

    result.push({
      clientId,
      state:
        draggingStale || edgeDraggingStale
          ? {
              ...state,
              dragging: draggingStale ? null : state.dragging,
              edgeDragging: edgeDraggingStale ? null : state.edgeDragging,
            }
          : state,
    });
  });

  // Drops bookkeeping for any clientId no longer present at all (peer
  // disconnected, or its Awareness entry itself timed out) — otherwise this
  // map would grow forever across a long session's worth of reconnects.
  for (const clientId of tracked.keys()) {
    if (!seen.has(clientId)) tracked.delete(clientId);
  }

  return result;
}

export function useRemotePresence(awareness: AwarenessHandle): RemotePresence[] {
  const trackedRef = useRef<Map<number, TrackedDragEntry>>(new Map());
  const [remotes, setRemotes] = useState<RemotePresence[]>(() => readRemotePresence(awareness, trackedRef.current));

  useEffect(() => {
    // A fresh `awareness` identity (a project switch tears down the old
    // provider) starts with no tracking history — otherwise a clientId
    // number reused across two unrelated documents could inherit stale
    // staleness bookkeeping from the wrong one.
    trackedRef.current = new Map();
    const sync = () => setRemotes(readRemotePresence(awareness, trackedRef.current));
    sync(); // resync immediately rather than waiting for the next remote change.
    awareness.on("change", sync);
    // Re-checks staleness even with no new Awareness event — see
    // `STALE_CHECK_INTERVAL_MS`'s own doc comment for why this can't just
    // be driven by the `"change"` event alone.
    const interval = setInterval(sync, STALE_CHECK_INTERVAL_MS);
    return () => {
      awareness.off("change", sync);
      clearInterval(interval);
    };
  }, [awareness]);

  return remotes;
}

function readRemotePresence(
  awareness: AwarenessHandle,
  tracked: Map<number, TrackedDragEntry>,
): RemotePresence[] {
  return derivePresenceWithFreshness(awareness.getStates(), awareness.clientID, tracked, Date.now());
}
