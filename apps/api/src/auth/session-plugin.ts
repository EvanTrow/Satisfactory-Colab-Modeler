import cookie from "@fastify/cookie";
import type { Session, User } from "@scm/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { getAuthConfig } from "./config.js";
import { findValidSession, SESSION_COOKIE_NAME, touchSession } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The authenticated user for this request, or `null` if not logged in / session invalid. */
    user: User | null;
    /** The resolved session row backing `request.user`, or `null`. */
    session: Session | null;
  }

  interface FastifyInstance {
    /**
     * A `preHandler` that 401s if `request.user` is not set. Register
     * routes needing auth with `{ preHandler: fastify.authenticate }`.
     * Job 006's project routes should use this rather than re-implementing
     * session checks.
     */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export interface SessionPluginOptions {
  /**
   * If false, skips registering `@fastify/cookie` (for hosts that already
   * register it themselves, e.g. to share one registration/secret across
   * plugins). Defaults to true.
   */
  registerCookiePlugin?: boolean;
}

/**
 * Session-validation middleware for `apps/api`. On every request, reads the
 * `sfm_session` cookie (if present), hashes it, looks up `sessions`, checks
 * `expires_at`, and attaches the resolved user/session to the request via
 * `request.user`/`request.session` — *without* rejecting the request. Routes
 * that require a logged-in user opt in via the `fastify.authenticate`
 * preHandler decorator (see `auth.routes.ts`'s `/auth/me` for an example),
 * so public routes (like `/auth/discord/login`) are unaffected.
 *
 * Also implements a simple sliding-window session refresh and bumps
 * `users.last_seen_at` on every request with a valid session — see
 * `session.ts`'s `touchSession`.
 */
export const sessionPlugin = fp(
  async (fastify, opts: SessionPluginOptions) => {
    if (opts.registerCookiePlugin !== false) {
      const { cookieSecret } = getAuthConfig();
      await fastify.register(cookie, { secret: cookieSecret });
    }

    fastify.decorateRequest("user", null);
    fastify.decorateRequest("session", null);

    fastify.addHook("onRequest", async (request) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (!token) {
        return;
      }

      const resolved = await findValidSession(token);
      if (!resolved) {
        return;
      }

      request.user = resolved.user;
      request.session = resolved.session;

      // Fire-and-forget from the request's perspective — this shouldn't
      // block the response, and a failure here shouldn't fail the request.
      touchSession(resolved).catch((err: unknown) => {
        request.log.error({ err }, "failed to refresh session / last_seen_at");
      });
    });

    fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        await reply.code(401).send({ error: "unauthorized" });
      }
    });
  },
  { name: "session-plugin" },
);
