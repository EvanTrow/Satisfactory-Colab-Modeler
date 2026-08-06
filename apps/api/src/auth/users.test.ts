import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { closeDb, db } from "../db.js";
import { upsertUserFromDiscordProfile } from "./users.js";

// These tests hit a real Postgres connection (DATABASE_URL), matching Job
// 004's precedent of verifying DB-dependent behavior against a real
// database rather than mocking Kysely/postgres.js. Each test uses a
// randomly generated discord_id so tests can run concurrently without
// colliding with each other or with other test files.

afterAll(async () => {
  await closeDb();
});

describe("upsertUserFromDiscordProfile", () => {
  it("inserts a new user on first login", async () => {
    const discordId = `test-${crypto.randomUUID()}`;
    const user = await upsertUserFromDiscordProfile({
      id: discordId,
      username: "first-username",
      global_name: "First Name",
      avatar: "abc123",
    });

    expect(user.discord_id).toBe(discordId);
    expect(user.username).toBe("first-username");
    expect(user.global_name).toBe("First Name");
    expect(user.avatar_hash).toBe("abc123");
    expect(user.id).toBeTruthy();
  });

  it("updates the existing row on a returning user's discord_id instead of creating a duplicate", async () => {
    const discordId = `test-${crypto.randomUUID()}`;

    const first = await upsertUserFromDiscordProfile({
      id: discordId,
      username: "old-name",
      global_name: "Old Global",
      avatar: "old-avatar",
    });

    const second = await upsertUserFromDiscordProfile({
      id: discordId,
      username: "new-name",
      global_name: "New Global",
      avatar: "new-avatar",
    });

    // Same row (same primary key), not a new one.
    expect(second.id).toBe(first.id);
    expect(second.username).toBe("new-name");
    expect(second.global_name).toBe("New Global");
    expect(second.avatar_hash).toBe("new-avatar");

    const rows = await db.selectFrom("users").selectAll().where("discord_id", "=", discordId).execute();
    expect(rows).toHaveLength(1);
  });

  it("allows global_name/avatar to be null (Discord users without a display name/avatar set)", async () => {
    const discordId = `test-${crypto.randomUUID()}`;
    const user = await upsertUserFromDiscordProfile({
      id: discordId,
      username: "no-extras",
      global_name: null,
      avatar: null,
    });

    expect(user.global_name).toBeNull();
    expect(user.avatar_hash).toBeNull();
  });
});
