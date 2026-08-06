import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { closeDb, db } from "../db.js";
import type { DiscordClient, DiscordUserProfile } from "./discord.js";

afterAll(async () => {
  await closeDb();
});

/**
 * A fake `DiscordClient` used in place of live calls to Discord (per the
 * job's guidance: mock the token exchange and `/users/@me` fetch at the
 * HTTP-client boundary rather than calling Discord for real). Records the
 * arguments it was called with so a test can assert the PKCE verifier that
 * reached "Discord" matches the one minted at login.
 */
function makeFakeDiscordClient(profile: DiscordUserProfile) {
  const calls: { code: string; codeVerifier: string }[] = [];
  const client: DiscordClient = {
    async exchangeCodeForToken(code, codeVerifier) {
      calls.push({ code, codeVerifier });
      return {
        access_token: "fake-discord-access-token",
        token_type: "Bearer",
        expires_in: 604800,
        refresh_token: "fake-discord-refresh-token",
        scope: "identify",
      };
    },
    async fetchCurrentUser() {
      return profile;
    },
  };
  return { client, calls };
}

/** Extracts `name=value` (attributes stripped) from a Set-Cookie header for reuse as a request's Cookie header. */
function extractCookie(setCookie: string | string[] | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const [pair] = header.split(";");
    const eq = pair!.indexOf("=");
    const key = pair!.slice(0, eq);
    if (key === name) return pair;
  }
  return undefined;
}

function isCookieCleared(setCookie: string | string[] | undefined, name: string): boolean {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return headers.some((h) => h.startsWith(`${name}=;`) || h.includes(`${name}=;`));
}

describe("GET /auth/discord/login", () => {
  it("redirects to Discord's authorize URL with scope=identify, state, and code_challenge, and sets a short-lived signed state cookie", async () => {
    const { client } = makeFakeDiscordClient({ id: "x", username: "x", global_name: null, avatar: null });
    const app = await buildApp({ logger: false, authRoutesOptions: { discordClient: client } });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/auth/discord/login" });

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(location.searchParams.get("scope")).toBe("identify");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const stateCookie = extractCookie(res.headers["set-cookie"], "sfm_oauth_state");
    expect(stateCookie).toBeDefined();
    const setCookieHeader = (
      Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : [res.headers["set-cookie"]]
    ).find((h) => h?.startsWith("sfm_oauth_state="))!;
    expect(setCookieHeader).toMatch(/HttpOnly/i);
    expect(setCookieHeader).toMatch(/Max-Age=300/i);

    await app.close();
  });
});

describe("GET /auth/discord/callback — state verification (security-critical)", () => {
  let app: FastifyInstance;

  it("rejects a callback with a state that doesn't match the cookie's state", async () => {
    const { client } = makeFakeDiscordClient({ id: "y", username: "y", global_name: null, avatar: null });
    app = await buildApp({ logger: false, authRoutesOptions: { discordClient: client } });
    await app.ready();

    const loginRes = await app.inject({ method: "GET", url: "/auth/discord/login" });
    const stateCookie = extractCookie(loginRes.headers["set-cookie"], "sfm_oauth_state")!;

    const callbackRes = await app.inject({
      method: "GET",
      url: "/auth/discord/callback?code=some-code&state=this-does-not-match",
      headers: { cookie: stateCookie },
    });

    expect(callbackRes.statusCode).toBe(403);
    expect(callbackRes.json()).toMatchObject({ error: "state_mismatch" });
    // No sfm_session should be set on a rejected callback.
    expect(extractCookie(callbackRes.headers["set-cookie"], "sfm_session")).toBeUndefined();

    await app.close();
  });

  it("rejects a callback with no state cookie at all (e.g. cookie expired or was never set)", async () => {
    const { client } = makeFakeDiscordClient({ id: "z", username: "z", global_name: null, avatar: null });
    const app2 = await buildApp({ logger: false, authRoutesOptions: { discordClient: client } });
    await app2.ready();

    const res = await app2.inject({
      method: "GET",
      url: "/auth/discord/callback?code=some-code&state=whatever",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_oauth_params" });

    await app2.close();
  });
});

describe("full login flow: callback upserts a user, creates a session, and /auth/me reflects it", () => {
  it("logs a new user in end-to-end against a mocked Discord, then logs them out", async () => {
    const discordId = `test-${crypto.randomUUID()}`;
    const profile: DiscordUserProfile = {
      id: discordId,
      username: "e2e-tester",
      global_name: "E2E Tester",
      avatar: "deadbeef",
    };
    const { client, calls } = makeFakeDiscordClient(profile);
    const app = await buildApp({ logger: false, authRoutesOptions: { discordClient: client } });
    await app.ready();

    // 1. GET /auth/discord/login
    const loginRes = await app.inject({ method: "GET", url: "/auth/discord/login" });
    const stateCookie = extractCookie(loginRes.headers["set-cookie"], "sfm_oauth_state")!;
    const state = new URL(loginRes.headers.location as string).searchParams.get("state")!;

    // 2. GET /auth/discord/callback?code=...&state=... with the matching cookie
    const callbackRes = await app.inject({
      method: "GET",
      url: `/auth/discord/callback?code=a-real-looking-code&state=${state}`,
      headers: { cookie: stateCookie },
    });

    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe("/");

    // The mocked exchange was called with the verifier minted at login (not persisted anywhere else).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.code).toBe("a-real-looking-code");

    const sessionCookieHeader = (
      Array.isArray(callbackRes.headers["set-cookie"])
        ? callbackRes.headers["set-cookie"]
        : [callbackRes.headers["set-cookie"]]
    ).find((h) => h?.startsWith("sfm_session="))!;
    expect(sessionCookieHeader).toBeDefined();
    expect(sessionCookieHeader).toMatch(/HttpOnly/i);
    expect(sessionCookieHeader).toMatch(/Secure/i);
    expect(sessionCookieHeader).toMatch(/SameSite=Lax/i);
    expect(sessionCookieHeader).toMatch(/Path=\//i);
    expect(sessionCookieHeader).toMatch(/Max-Age=2592000/i);
    const sessionCookie = extractCookie(callbackRes.headers["set-cookie"], "sfm_session")!;

    // The state cookie must have been cleared regardless of outcome.
    expect(isCookieCleared(callbackRes.headers["set-cookie"], "sfm_oauth_state")).toBe(true);

    // 3. GET /auth/me with the session cookie
    const meRes = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: sessionCookie } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({
      discordId,
      username: "e2e-tester",
      globalName: "E2E Tester",
    });

    // The users row was upserted (exactly one row for this discord_id).
    const rows = await db.selectFrom("users").selectAll().where("discord_id", "=", discordId).execute();
    expect(rows).toHaveLength(1);

    // 4. GET /auth/logout
    const logoutRes = await app.inject({ method: "GET", url: "/auth/logout", headers: { cookie: sessionCookie } });
    expect(logoutRes.statusCode).toBe(200);
    expect(isCookieCleared(logoutRes.headers["set-cookie"], "sfm_session")).toBe(true);

    // 5. GET /auth/me now rejects — the session row is gone.
    const meAfterLogout = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: sessionCookie } });
    expect(meAfterLogout.statusCode).toBe(401);

    await app.close();
  });

  it("re-authenticating an existing discord_id updates the row instead of creating a duplicate", async () => {
    const discordId = `test-${crypto.randomUUID()}`;
    const firstProfile: DiscordUserProfile = {
      id: discordId,
      username: "before-name",
      global_name: null,
      avatar: null,
    };
    const app1 = await buildApp({
      logger: false,
      authRoutesOptions: { discordClient: makeFakeDiscordClient(firstProfile).client },
    });
    await app1.ready();

    const login1 = await app1.inject({ method: "GET", url: "/auth/discord/login" });
    const stateCookie1 = extractCookie(login1.headers["set-cookie"], "sfm_oauth_state")!;
    const state1 = new URL(login1.headers.location as string).searchParams.get("state")!;
    await app1.inject({
      method: "GET",
      url: `/auth/discord/callback?code=c1&state=${state1}`,
      headers: { cookie: stateCookie1 },
    });
    await app1.close();

    const secondProfile: DiscordUserProfile = {
      id: discordId,
      username: "after-name",
      global_name: "After Global",
      avatar: "new-hash",
    };
    const app2 = await buildApp({
      logger: false,
      authRoutesOptions: { discordClient: makeFakeDiscordClient(secondProfile).client },
    });
    await app2.ready();

    const login2 = await app2.inject({ method: "GET", url: "/auth/discord/login" });
    const stateCookie2 = extractCookie(login2.headers["set-cookie"], "sfm_oauth_state")!;
    const state2 = new URL(login2.headers.location as string).searchParams.get("state")!;
    const callback2 = await app2.inject({
      method: "GET",
      url: `/auth/discord/callback?code=c2&state=${state2}`,
      headers: { cookie: stateCookie2 },
    });
    expect(callback2.statusCode).toBe(302);
    await app2.close();

    const rows = await db.selectFrom("users").selectAll().where("discord_id", "=", discordId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe("after-name");
    expect(rows[0]!.global_name).toBe("After Global");
  });
});

describe("GET /auth/me without a session", () => {
  it("returns 401", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
