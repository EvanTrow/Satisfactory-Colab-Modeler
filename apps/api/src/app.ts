import Fastify, { type FastifyInstance } from "fastify";

import { authRoutes, type AuthRoutesOptions } from "./auth/routes.js";
import { sessionPlugin } from "./auth/session-plugin.js";
import { captureException } from "./monitoring/sentry.js";
import { projectDocRoutes } from "./projects/docRoutes.js";
import { projectInviteRoutes } from "./projects/inviteRoutes.js";
import { projectMemberRoutes } from "./projects/memberRoutes.js";
import { projectRoutes } from "./projects/routes.js";
import { realtimeRoutes } from "./routes/realtime.js";
import { registerStaticSite } from "./staticSite.js";

export interface BuildAppOptions {
  logger?: boolean;
  /** Passed through to `authRoutes` — tests use this to inject a mocked `DiscordClient`. */
  authRoutesOptions?: AuthRoutesOptions;
  /** Job 029: absolute path to `apps/web`'s built `dist/` — see `staticSite.ts`'s header comment. Defaults to `process.env.WEB_DIST_DIR` (unset in every existing dev/test environment, so this is a no-op unless `infra/Dockerfile`'s production image sets it). */
  webDistDir?: string;
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

  // Job 029: reports every server-side error that reaches Fastify's own
  // error pipeline to Sentry (a no-op call when `SENTRY_DSN` is unset —
  // see `monitoring/sentry.ts`'s header comment), WITHOUT changing what
  // gets sent back to the client — `onError` is a pure observer hook, not
  // `setErrorHandler`, specifically so this can't alter any existing
  // route's response shape or status code. Only genuine 5xx-or-unset
  // errors are reported — an expected 401/403/404 (any handler that sets
  // its own `statusCode` below 500, e.g. `roles.ts`'s auth checks) is not
  // a bug worth paging anyone over.
  app.addHook("onError", async (request, _reply, error) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode < 500) return;
    captureException(error, { url: request.url, method: request.method });
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
  // Job 022: invite creation/listing/revocation (owner-only) + public
  // preview/redemption (`project_invites` — unused since Job 004's
  // migration until now). See inviteRoutes.ts's header comment.
  await app.register(projectInviteRoutes);
  // Job 020: GET /api/realtime/ticket — mints the short-lived JWT
  // apps/realtime's Hocuspocus server verifies in onAuthenticate.
  await app.register(realtimeRoutes);

  // Job 029: serves `apps/web`'s built static assets from this same
  // origin/port in production — see `staticSite.ts`'s header comment.
  // Registered last (see that function's own doc comment on why order
  // doesn't affect correctness, only readability). A complete no-op when
  // neither `opts.webDistDir` nor `WEB_DIST_DIR` is set, which is every
  // existing dev/test environment.
  await registerStaticSite(app, { webDistDir: opts.webDistDir ?? process.env.WEB_DIST_DIR });

  return app;
}
