import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { closeDb, db } from "../db.js";
import {
  createSession,
  deleteSessionByToken,
  findValidSession,
  hashSessionToken,
  SESSION_TTL_MS,
} from "./session.js";
import { upsertUserFromDiscordProfile } from "./users.js";

afterAll(async () => {
  await closeDb();
});

async function makeTestUser() {
  return upsertUserFromDiscordProfile({
    id: `test-${crypto.randomUUID()}`,
    username: "session-test-user",
    global_name: null,
    avatar: null,
  });
}

describe("createSession / findValidSession", () => {
  it("creates a session whose raw token resolves back to the same user, and stores only its hash", async () => {
    const user = await makeTestUser();
    const { token, session } = await createSession({ userId: user.id });

    expect(session.user_id).toBe(user.id);
    // The stored value is the SHA-256 hash, not the raw token.
    expect(session.token_hash.equals(hashSessionToken(token))).toBe(true);
    expect(session.token_hash.equals(Buffer.from(token))).toBe(false);

    const resolved = await findValidSession(token);
    expect(resolved).not.toBeNull();
    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.session.id).toBe(session.id);
  });

  it("rejects an unknown token", async () => {
    const resolved = await findValidSession("this-token-was-never-issued");
    expect(resolved).toBeNull();
  });

  it("rejects an expired session (session expiry is enforced)", async () => {
    const user = await makeTestUser();
    const { token, session } = await createSession({ userId: user.id });

    // Backdate expires_at into the past, simulating an expired session.
    await db
      .updateTable("sessions")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", session.id)
      .execute();

    const resolved = await findValidSession(token);
    expect(resolved).toBeNull();
  });

  it("accepts a session that is still within its TTL", async () => {
    const user = await makeTestUser();
    const { token, session } = await createSession({ userId: user.id });

    // Sanity check the TTL we're relying on is actually ~30 days out.
    const remainingMs = new Date(session.expires_at).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(SESSION_TTL_MS - 60_000);

    const resolved = await findValidSession(token);
    expect(resolved).not.toBeNull();
  });
});

describe("deleteSessionByToken", () => {
  it("removes the session row so the token no longer resolves", async () => {
    const user = await makeTestUser();
    const { token } = await createSession({ userId: user.id });

    expect(await findValidSession(token)).not.toBeNull();

    await deleteSessionByToken(token);

    expect(await findValidSession(token)).toBeNull();
  });

  it("is a no-op for a token that doesn't exist", async () => {
    await expect(deleteSessionByToken("never-existed")).resolves.not.toThrow();
  });
});
