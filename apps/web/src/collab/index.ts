// Job 021: presence (cursors, avatars, selection halos, soft field
// indicators) — PLAN.md §7's `apps/web/src/collab/` entry ("Yjs provider,
// awareness, presence UI"). The live `HocuspocusProvider`/`awareness`
// instance itself still lives in `canvas/persistence/useProjectDocument.ts`
// (Job 020) and is threaded through `CanvasDocContext` (see that file's
// Handoff notes) — everything in this directory consumes an already-live
// `AwarenessHandle`, none of it constructs one.
export {
  colorFromUserId,
  createLocalAwarenessState,
  isCursorVisibleInContainer,
  parseAwarenessState,
  selectVisibleCursors,
  type AwarenessCursor,
  type AwarenessEditingField,
  type AwarenessHandle,
  type AwarenessState,
  type LocalUserIdentity,
} from "./awareness";
export { discordAvatarUrl, defaultAvatarIndex } from "./discordAvatar";
export { createThrottled } from "./throttle";
export { useRemotePresence, type RemotePresence } from "./useRemotePresence";
export { useLocalPresence, type LocalPresenceControls } from "./useLocalPresence";
export { useCursorPublisher, type CursorPublisherHandlers } from "./useCursorPublisher";
export { useSelectionPublisher } from "./useSelectionPublisher";
export { Avatar, type AvatarProps } from "./Avatar";
export { PresenceAvatarList, type PresenceAvatarListProps } from "./PresenceAvatarList";
export { PresenceCursors, type PresenceCursorsProps } from "./PresenceCursors";
export { FieldPresenceRing, type FieldPresenceRingProps } from "./FieldPresenceRing";
