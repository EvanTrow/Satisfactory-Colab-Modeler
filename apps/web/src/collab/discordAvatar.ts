// Job 021: constructs a real Discord CDN avatar URL from the raw profile
// fields `GET /auth/me` (Job 005) returns — that endpoint's `avatarHash` is
// a raw Discord avatar hash, not a ready-to-use URL (see `App.tsx`'s
// `CurrentUser` interface). This is the one small piece of client-side logic
// needed to turn it into something an `<img src>` can actually load, used
// both for this client's own local Awareness `avatarUrl` field
// (`App.tsx`/`useLocalPresence.ts`) and, indirectly, for whatever a remote
// peer's browser did the same computation for on their end (their computed
// URL — not this function — travels over Awareness as a plain string; every
// client runs this exact same derivation independently, so two clients
// always agree on the same user's avatar URL).
//
// Standard Discord CDN pattern, confirmed against Discord's own developer
// docs (https://discord.com/developers/docs/reference#image-formatting,
// https://discord.com/developers/docs/reference#default-user-avatar):
//   - a real avatar hash: `https://cdn.discordapp.com/avatars/{userId}/{hash}.{ext}`
//     (`.gif` for an animated hash — Discord marks those with a literal
//     `a_` prefix on the hash itself; `.png` otherwise). No attempt is made
//     here to force a static frame for an animated avatar (e.g. via a
//     `?format=png` no-op that Discord doesn't actually honor for reformatting
//     an animated source) — an animated `.gif` still renders correctly as a
//     plain (if moving) image wherever this app puts it in an `<img>` tag,
//     and adding that polish wasn't worth the extra surface for a presence
//     avatar that's already quite small on screen.
//   - no avatar hash at all (never set a custom avatar): Discord's own
//     "default avatar" convention, keyed by the user's snowflake id:
//     `index = (BigInt(userId) >> 22n) % 6n`, rendered at
//     `https://cdn.discordapp.com/embed/avatars/{index}.png`. This is the
//     *current* (migrated-off-discriminator) scheme Discord's docs describe;
//     the deliberately simple `defaultAvatarIndex` below doesn't attempt to
//     also support the legacy `discriminator % 5` scheme for pre-migration
//     accounts, since `users.discord_id` (what this app stores, per
//     `db/migrations`) is always the snowflake, never a discriminator.
export function discordAvatarUrl(discordId: string, avatarHash: string | null): string {
  if (avatarHash) {
    const extension = avatarHash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.${extension}`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex(discordId)}.png`;
}

/**
 * `(snowflake >> 22) % 6`, per Discord's own default-avatar docs. Wrapped in
 * a `try`/`catch` only as a defensive fallback for a non-numeric id (should
 * never happen for a real Discord snowflake, which `users.discord_id` always
 * is) — `BigInt("not a number")` throws rather than returning `NaN` the way
 * `Number(...)` would, so an unguarded call here could otherwise crash
 * whatever's rendering an avatar list over one bad row instead of just
 * falling back to a single, stable placeholder index.
 */
export function defaultAvatarIndex(discordId: string): number {
  try {
    return Number((BigInt(discordId) >> 22n) % 6n);
  } catch {
    return 0;
  }
}
