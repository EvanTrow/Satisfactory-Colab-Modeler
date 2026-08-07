// Job 029: serves `apps/web`'s built static output from the SAME origin
// as the API, so a production deploy can be genuinely "a single container"
// (PLAN.md's confirmed decision) rather than needing a second host/CDN for
// the SPA. In dev, this is a complete no-op — Vite's own dev server (port
// 5173) serves `apps/web` and proxies `/auth`/`/api`/`/collab` to this API
// (see `apps/web/vite.config.ts`), exactly as every prior job left it.
//
// Gated entirely behind `WEB_DIST_DIR` being set: unset (the default in
// every existing dev/test environment) means `registerStaticSite` does
// nothing at all — not even attaching a 404 fallback — so this cannot
// change any existing route's behavior when the env var is absent. Only
// `infra/Dockerfile`'s production image sets it.
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Path prefixes this app already owns as real API routes. A GET request
 * whose path starts with one of these that doesn't match a real route (or
 * a real static file) should fall through to Fastify's normal 404 — NOT
 * the SPA's `index.html` — so a typo'd API call fails loudly instead of
 * silently getting an HTML document back with a 200 that then fails to
 * `JSON.parse` client-side. Everything else (an unmatched GET, e.g.
 * `/p/abc123/edit` or `/i/some-token`) is a client-side "route" `App.tsx`
 * resolves itself via `pathname` parsing (see that file's own header
 * comment — there is no server-side router), so it needs `index.html`.
 */
const API_PATH_PREFIXES = ["/api/", "/auth/", "/health", "/collab/"];

function isApiPath(url: string): boolean {
  return API_PATH_PREFIXES.some((prefix) => url === prefix.replace(/\/$/, "") || url.startsWith(prefix));
}

export interface StaticSiteOptions {
  /** Absolute path to `apps/web`'s built `dist/` directory. If unset, this whole module is a no-op — see this file's header comment. */
  webDistDir?: string;
}

/**
 * Registers `@fastify/static` over `webDistDir` plus a GET-only,
 * non-API-path SPA fallback to `index.html` (so a hard refresh on
 * `/p/:shortId/edit` or a shared `/i/:token` link works, not just
 * client-side navigation from `/`). Must be registered AFTER every real
 * route plugin in `app.ts` — Fastify only reaches a `setNotFoundHandler`
 * once nothing else matched, so route registration order relative to this
 * call doesn't actually matter for correctness, but registering it last
 * keeps the intent readable (this is the catch-all).
 */
export async function registerStaticSite(app: FastifyInstance, options: StaticSiteOptions): Promise<void> {
  const { webDistDir } = options;
  if (!webDistDir) return;

  await app.register(fastifyStatic, {
    root: webDistDir,
    // Serves `index.html` natively for a directory-style request (i.e.
    // `GET /`) — needed so the site root itself works, not just deep
    // links. `setHeaders` below overrides this file's cache header
    // specifically; see that option's own comment for why.
    index: ["index.html"],
    // The SPA's own JS/CSS bundles are content-hashed by Vite (Job 001's
    // scaffold, unchanged since) — safe to cache aggressively.
    cacheControl: true,
    maxAge: "1y",
    immutable: true,
    // Runs AFTER this plugin's own `cacheControl`/`maxAge` headers are
    // already set (confirmed against @fastify/static's source — `setHeaders`
    // fires after `reply.headers(headers)`), so it can override them.
    // `index.html` is the one file that must never be cached long-lived —
    // it's the SPA shell that has to reflect a fresh deploy immediately,
    // unlike its content-hashed JS/CSS bundles, and it's reached via BOTH
    // this plugin's own root-index serving above AND the manual
    // `reply.sendFile("index.html", ...)` fallback below (`setHeaders` is
    // shared by both code paths, so this one override covers both).
    setHeaders(reply, filePath) {
      if (filePath.endsWith("index.html")) {
        reply.header("cache-control", "no-cache");
      }
    },
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || isApiPath(request.url)) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    void reply.sendFile("index.html", webDistDir);
  });
}
