// Job 029: `registerStaticSite`'s two behaviors — a complete no-op when
// `webDistDir` is unset (proving this job's static-serving addition can't
// change any existing dev/test route behavior), and, when set, serving a
// real built asset plus SPA-fallback/API-passthrough for everything else.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { closeDb } from "./db.js";

afterAll(async () => {
  await closeDb();
});

describe("registerStaticSite — webDistDir unset (every existing dev/test environment)", () => {
  it("does not intercept an unmatched GET — the existing default 404 shape is unchanged", async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/some/spa/route" });
    expect(res.statusCode).toBe(404);
    // Fastify's own default not-found body, NOT this job's HTML fallback —
    // proves `setNotFoundHandler` was never called at all when unset.
    expect(JSON.parse(res.body)).toMatchObject({ error: "Not Found" });
  });

  it("/health still works exactly as before", async () => {
    const app = await buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});

describe("registerStaticSite — webDistDir set (production shape)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeBuiltWebDist(): string {
    const d = mkdtempSync(path.join(tmpdir(), "scm-web-dist-"));
    writeFileSync(path.join(d, "index.html"), "<!doctype html><html><body>spa-shell</body></html>");
    writeFileSync(path.join(d, "app.js"), "console.log('hi')");
    return d;
  }

  it("serves a real static asset with a long-lived cache header", async () => {
    dir = makeBuiltWebDist();
    const app = await buildApp({ logger: false, webDistDir: dir });
    const res = await app.inject({ method: "GET", url: "/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("console.log('hi')");
    expect(res.headers["cache-control"]).toContain("max-age");
  });

  it("falls back to index.html for an unmatched GET (SPA client-side route) with no-cache", async () => {
    dir = makeBuiltWebDist();
    const app = await buildApp({ logger: false, webDistDir: dir });
    const res = await app.inject({ method: "GET", url: "/p/abc123/edit" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("spa-shell");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("falls back to index.html for the root path", async () => {
    dir = makeBuiltWebDist();
    const app = await buildApp({ logger: false, webDistDir: dir });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("spa-shell");
  });

  it("does NOT fall back to index.html for an unmatched /api/ path — real 404 instead", async () => {
    dir = makeBuiltWebDist();
    const app = await buildApp({ logger: false, webDistDir: dir });
    const res = await app.inject({ method: "GET", url: "/api/this-route-does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("spa-shell");
  });

  it("does NOT fall back to index.html for an unmatched /auth/ path", async () => {
    dir = makeBuiltWebDist();
    const app = await buildApp({ logger: false, webDistDir: dir });
    const res = await app.inject({ method: "GET", url: "/auth/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("spa-shell");
  });

  it("does NOT fall back to index.html for a non-GET request", async () => {
    dir = makeBuiltWebDist();
    const app = await buildApp({ logger: false, webDistDir: dir });
    const res = await app.inject({ method: "POST", url: "/some/spa/route" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("spa-shell");
  });
});
