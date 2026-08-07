// Job 021: the top-bar "who's currently connected" row — PLAN.md §3's
// "presence avatars" MVP bullet. Mounted once in `CanvasView.tsx`'s header,
// next to `SaveStatusIndicator`. Always shows the local user first (labeled
// "(you)" in its tooltip), then every remote peer currently in
// `useRemotePresence`'s live list — including a **viewer**-role peer: Job
// 020 gives every role (owner/editor/viewer) a live provider connection, and
// PLAN.md never scopes presence itself to editors only, so a project owner
// can see a viewer is currently looking at the project too.
import { colorFromUserId, type AwarenessHandle, type LocalUserIdentity } from "./awareness";
import { Avatar } from "./Avatar";
import { useRemotePresence } from "./useRemotePresence";

export interface PresenceAvatarListProps {
  awareness: AwarenessHandle;
  localUser: LocalUserIdentity;
}

export function PresenceAvatarList({ awareness, localUser }: PresenceAvatarListProps) {
  const remote = useRemotePresence(awareness);

  return (
    <div className="flex items-center -space-x-2" title="Who's here">
      <Avatar
        avatarUrl={localUser.avatarUrl}
        displayName={`${localUser.displayName} (you)`}
        color={colorFromUserId(localUser.id)}
      />
      {remote.map(({ clientId, state }) => (
        <Avatar key={clientId} avatarUrl={state.avatarUrl} displayName={state.displayName} color={state.color} />
      ))}
    </div>
  );
}
