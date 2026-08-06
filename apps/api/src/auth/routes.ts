import crypto from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { getAuthConfig } from "./config.js";
import { buildAuthorizeUrl, createDiscordClient, type DiscordClient } from "./discord.js";
import { generatePkcePair, generateState } from "./pkce.js";
import { createSession, deleteSessionByToken, SESSION_COOKIE_NAME, SESSION_TTL_MS } from "./session.js";
import { upsertUserFromDiscordProfile } from "./users.js";

/** Cookie holding the CSRF `state` + PKCE `code_verifier` between login and callback. */
const OAUTH_STATE_COOKIE = "sfm_oauth_state";
/** 5 minutes, per PLAN.md §6. */
const OAUTH_STATE_TTL_SECONDS = 5 * 60;

interface OAuthStateCookiePayload {
  state: string;
  codeVerifier: string;
}

export interface AuthRoutesOptions {
  /**
   * Overrides the real Discord HTTP client — the seam tests use to mock
   * the authorization-code exchange and `/users/@me` fetch instead of
   * calling Discord for real. Defaults to a real `fetch`-backed client
   * built from env config.
   */
  discordClient?: DiscordClient;
  /** Where `/auth/discord/callback` redirects on success. Defaults to `/`. */
  postLoginRedirect?: string;
}

/**
 * Registers the Discord OAuth2 login flow (PLAN.md §6):
 *   - `GET /auth/discord/login`
 *   - `GET /auth/discord/callback`
 *   - `GET /auth/logout`
 *   - `GET /auth/me`
 *
 * Assumes `sessionPlugin` (`./session-plugin.ts`) is already registered on
 * the app, since `/auth/me` relies on `request.user` being populated by it.
 */
export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (fastify, opts) => {
  const config = getAuthConfig();
  const discordClient = opts.discordClient ?? createDiscordClient(config.discord);
  const postLoginRedirect = opts.postLoginRedirect ?? "/";

  fastify.get("/auth/discord/login", async (_request, reply) => {
    const state = generateState();
    const { codeVerifier, codeChallenge } = generatePkcePair();

    const payload: OAuthStateCookiePayload = { state, codeVerifier };
    reply.setCookie(OAUTH_STATE_COOKIE, JSON.stringify(payload), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/auth/discord",
      maxAge: OAUTH_STATE_TTL_SECONDS,
      signed: true,
    });

    const authorizeUrl = buildAuthorizeUrl(config.discord, { state, codeChallenge });
    return reply.redirect(authorizeUrl, 302);
  });

  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/discord/callback",
    async (request, reply) => {
      const { code, state, error } = request.query;
      const rawStateCookie = request.cookies[OAUTH_STATE_COOKIE];

      // Clear the state cookie immediately — it's single-use regardless of
      // whether this callback ends up succeeding or failing.
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/auth/discord" });

      if (error) {
        return reply.code(400).send({ error: "discord_oauth_error", detail: error });
      }

      if (!code || !state || !rawStateCookie) {
        return reply.code(400).send({ error: "missing_oauth_params" });
      }

      const unsigned = request.unsignCookie(rawStateCookie);
      if (!unsigned.valid || unsigned.value === null) {
        return reply.code(400).send({ error: "invalid_oauth_state_cookie" });
      }

      let storedPayload: OAuthStateCookiePayload;
      try {
        storedPayload = JSON.parse(unsigned.value) as OAuthStateCookiePayload;
      } catch {
        return reply.code(400).send({ error: "invalid_oauth_state_cookie" });
      }

      // Security-critical CSRF check (PLAN.md §6 / job acceptance
      // criteria): the `state` returned by Discord must match the one we
      // minted and stashed in the signed cookie. Reject on any mismatch —
      // never silently proceed. `timingSafeEqual` requires equal-length
      // buffers, so a length mismatch is treated as "not equal" up front
      // rather than being fed to it (which would throw).
      if (!constantTimeEquals(storedPayload.state, state)) {
        return reply.code(403).send({ error: "state_mismatch" });
      }

      let accessToken: string;
      try {
        const tokenResponse = await discordClient.exchangeCodeForToken(code, storedPayload.codeVerifier);
        accessToken = tokenResponse.access_token;
        // `tokenResponse` (which carries Discord's access AND refresh
        // tokens) is deliberately not referenced again past this line, not
        // stored anywhere, and never logged — PLAN.md §6 requires
        // discarding both immediately after establishing identity.
      } catch (err) {
        request.log.error({ err: err instanceof Error ? err.message : err }, "discord token exchange failed");
        return reply.code(502).send({ error: "discord_token_exchange_failed" });
      }

      let profile;
      try {
        profile = await discordClient.fetchCurrentUser(accessToken);
      } catch (err) {
        request.log.error({ err: err instanceof Error ? err.message : err }, "discord user fetch failed");
        return reply.code(502).send({ error: "discord_user_fetch_failed" });
      }
      // `accessToken` also goes out of scope here, for the same reason.

      const user = await upsertUserFromDiscordProfile(profile);

      const { token } = await createSession({
        userId: user.id,
        userAgent: request.headers["user-agent"] ?? null,
        ip: request.ip,
      });

      reply.setCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
      });

      return reply.redirect(postLoginRedirect, 302);
    },
  );

  fastify.get("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) {
      await deleteSessionByToken(token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.send({ ok: true });
  });

  fastify.get("/auth/me", { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      // fastify.authenticate already sent the 401; this is unreachable but
      // keeps TypeScript from widening `user` to possibly-null below.
      return reply;
    }
    return reply.send({
      id: user.id,
      discordId: user.discord_id,
      username: user.username,
      globalName: user.global_name,
      avatarHash: user.avatar_hash,
      createdAt: user.created_at,
      lastSeenAt: user.last_seen_at,
    });
  });
};

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
