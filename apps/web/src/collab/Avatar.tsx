// Job 021: a small, reusable presence avatar — a circular image (a real
// Discord avatar URL, see `discordAvatar.ts`) ringed in the user's own
// derived `color` (`awareness.ts`'s `colorFromUserId`), with an initials
// fallback if the image URL 404s (a plausible real-world case: a user
// changes their Discord avatar after this app cached/derived the old
// hash-based URL, or a `default-avatar` embed URL momentarily fails to
// load). Used by `PresenceAvatarList.tsx` (the top-bar "who's here" row) and
// `FieldPresenceRing.tsx` (the small badge next to a field someone else is
// editing).
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

  return (
    <span
      title={displayName}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-[var(--surface-sunken)] text-[10px] font-semibold text-[var(--text-primary)] ${className ?? ""}`}
      style={{ width: size, height: size, borderColor: color }}
    >
      {failed ? (
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
