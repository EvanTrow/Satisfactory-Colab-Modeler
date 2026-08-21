// Job 021: a small, reusable presence avatar — a circular image (a real
// Discord avatar URL, see `discordAvatar.ts`) ringed in the user's own
// derived `color` (`awareness.ts`'s `colorFromUserId`), with an initials
// fallback if the image URL 404s (a plausible real-world case: a user
// changes their Discord avatar after this app cached/derived the old
// hash-based URL, or a `default-avatar` embed URL momentarily fails to
// load). Used by `PresenceAvatarList.tsx` (the top-bar "who's here" row) and
// `FieldPresenceRing.tsx` (the small badge next to a field someone else is
// editing).
//
// Guest-mode / public-link work: `GuestCanvasView.tsx`'s local-only identity
// and `PublicCanvasView.tsx`'s anonymous public-viewer identity both pass
// `avatarUrl: ""` (there's no real photo to show for either). An empty
// `src` on an `<img>` doesn't reliably fire `onError` (in some browsers it's
// silently treated as "no request to make" rather than a load failure), so
// the old code — which only ever showed the initials fallback once `onError`
// had actually fired — rendered a blank, borderless-looking circle for a
// guest that never resolved into anything. This is now a distinct, checked
// case: no `avatarUrl` at all always renders a generic person icon
// immediately (never even mounts the `<img>`), reserving the initials
// fallback for what it was originally for — a REAL avatar URL that failed to
// load for a real, named user.
import { User } from "lucide-react";
import { useState } from "react";

export interface AvatarProps {
  avatarUrl: string;
  displayName: string;
  color: string;
  size?: number;
  className?: string;
}

export function Avatar({ avatarUrl, displayName, color, size = 22, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  const hasAvatarUrl = avatarUrl.trim().length > 0;

  return (
    <span
      title={displayName}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-[var(--surface-sunken)] text-[10px] font-semibold text-[var(--text-primary)] ${className ?? ""}`}
      style={{ width: size, height: size, borderColor: color }}
    >
      {!hasAvatarUrl ? (
        <User
          aria-hidden
          className="text-[var(--text-secondary)]"
          style={{ width: size * 0.6, height: size * 0.6 }}
        />
      ) : failed ? (
        initial
      ) : (
        <img
          src={avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
