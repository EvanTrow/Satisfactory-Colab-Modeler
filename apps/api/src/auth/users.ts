import type { User } from "@scm/db";

import { db } from "../db.js";
import type { DiscordUserProfile } from "./discord.js";

/**
 * Inserts a new `users` row for a Discord identity, or updates the existing
 * one if `discord_id` already exists — a real `ON CONFLICT` upsert (not a
 * select-then-insert race), per Job 004's handoff note that `discord_id` is
 * `unique not null` and a returning user's login must not attempt a blind
 * insert. Re-authenticating an existing user updates `username`/
 * `global_name`/`avatar_hash` (Discord profile fields can change) and bumps
 * `last_seen_at`, without creating a duplicate row.
 */
export async function upsertUserFromDiscordProfile(profile: DiscordUserProfile): Promise<User> {
  return db
    .insertInto("users")
    .values({
      discord_id: profile.id,
      username: profile.username,
      global_name: profile.global_name,
      avatar_hash: profile.avatar,
      last_seen_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column("discord_id").doUpdateSet({
        username: profile.username,
        global_name: profile.global_name,
        avatar_hash: profile.avatar,
        last_seen_at: new Date(),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}
