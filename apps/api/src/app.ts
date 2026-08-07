import Fastify, { type FastifyInstance } from "fastify";

import { authRoutes, type AuthRoutesOptions } from "./auth/routes.js";
import { sessionPlugin } from "./auth/session-plugin.js";
import { projectDocRoutes } from "./projects/docRoutes.js";
import { projectMemberRoutes } from "./projects/memberRoutes.js";
import { projectRoutes } from "./projects/routes.js";
import { realtimeRoutes } from "./routes/realtime.js";

export interface BuildAppOptions {
  logger?: boolean;
  /** Passed through to `authRoutes` — tests use this to inject a mocked `DiscordClient`. */
  authRoutesOptions?: AuthRoutesOptions;
}

/**
 * Builds (but does not start listening on) the Fastify app. Split out from
 * `index.ts` so tests can build an app with a mocked `DiscordClient` and
 * drive it with `app.inject()` instead of binding a real port and making
 * live calls to Discord.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
  });

  app.get("/health", async () => {
    return { ok: true };
  });

  // Session-validation middleware must be registered before the routes
  // that depend on `request.user`/`fastify.authenticate` (Job 006's
  // project routes will need the same decorator — see
  // auth/session-plugin.ts's doc comment).
  await app.register(sessionPlugin);
  await app.register(authRoutes, opts.authRoutesOptions ?? {});
  // Registered as a sibling plugin to authRoutes, both attaching to the
  // same root app — sessionPlugin's decorators (`fastify.authenticate`,
  // `request.user`) are globally visible via fastify-plugin, not scoped to
  // authRoutes's own encapsulation context.
  await app.register(projectRoutes);
  // Job 015: doc load/push routes, kept in their own plugin/file
  // (docRoutes.ts) rather than folded into routes.ts, since they're a
  // meaningfully different concern (bytes, not JSON metadata) built on top
  // of the same auth/role-resolution primitives.
  await app.register(projectDocRoutes);
  // Job 020: minimal owner-only member management (list/change-role/remove)
  // — see memberRoutes.ts's header comment for why this exists now rather
  // than waiting for Job 022's full sharing/invite flow.
  await app.register(projectMemberRoutes);
  // Job 020: GET /api/realtime/ticket — mints the short-lived JWT
  // apps/realtime's Hocuspocus server verifies in onAuthenticate.
  await app.register(realtimeRoutes);

  return app;
}
