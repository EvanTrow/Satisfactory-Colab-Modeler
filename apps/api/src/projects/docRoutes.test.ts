import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session.js";
import { closeDb, db } from "../db.js";

// These tests hit a real Postgres connection (DATABASE_URL), same precedent
// as projects/routes.test.ts.

afterAll(async () => {
  await closeDb();
});

async function createTestUser(username: string) {
  return db
    .insertInto("users")
    .values({ discord_id: `test-${crypto.randomUUID()}`, username })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function cookieFor(userId: string): Promise<string> {
  const { token } = await createSession({ userId });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function markerUpdateBase64(marker: string): string {
  const doc = new Y.Doc();
  doc.transact(() => doc.getMap("meta").set("marker", marker));
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

describe("GET /api/projects/:id/doc", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/api/projects/${crypto.randomUUID()}/doc` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns an empty-but-applyable update for a brand-new project with no doc content yet", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("docroutes-empty-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/doc`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.update).toBe("string");

    // Applying it to a fresh doc must not throw and must leave it empty.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(body.update, "base64"));
    expect(doc.getMap("meta").size).toBe(0);

    await app.close();
  });

  it("returns 404 for a non-member (does not leak project existence)", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("docroutes-owner-1");
    const stranger = await createTestUser("docroutes-stranger-1");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/doc`, headers: { cookie: strangerCookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("lets a viewer load the document", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("docroutes-owner-2");
    const viewer = await createTestUser("docroutes-viewer-1");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();

    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/doc`, headers: { cookie: viewerCookie } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("POST /api/projects/:id/doc/updates", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "POST", url: `/api/projects/${crypto.randomUUID()}/doc/updates` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("appends an update as the owner, and a subsequent GET reflects it", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("docroutes-append-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();

    const pushRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/doc/updates`,
      headers: { cookie },
      payload: { update: markerUpdateBase64("owner-pushed") },
    });
    expect(pushRes.statusCode).toBe(204);

    const getRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}/doc`, headers: { cookie } });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(getRes.json().update, "base64"));
    expect(doc.getMap("meta").get("marker")).toBe("owner-pushed");

    const rows = await db.selectFrom("project_doc_updates").selectAll().where("project_id", "=", project.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(owner.id);

    await app.close();
  });

  it("appends an update as an editor", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("docroutes-owner-3");
    const editor = await createTestUser("docroutes-editor-1");
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: editor.id, role: "editor" }).execute();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/doc/updates`,
      headers: { cookie: editorCookie },
      payload: { update: markerUpdateBase64("editor-pushed") },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("rejects a viewer's push with 403 — the update is not persisted", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("docroutes-owner-4");
    const viewer = await createTestUser("docroutes-viewer-2");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/doc/updates`,
      headers: { cookie: viewerCookie },
      payload: { update: markerUpdateBase64("viewer-should-not-persist") },
    });
    expect(res.statusCode).toBe(403);

    const rows = await db.selectFrom("project_doc_updates").selectAll().where("project_id", "=", project.id).execute();
    expect(rows).toHaveLength(0);

    await app.close();
  });

  it("returns 404 for a non-member's push", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("docroutes-owner-5");
    const stranger = await createTestUser("docroutes-stranger-2");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/doc/updates`,
      headers: { cookie: strangerCookie },
      payload: { update: markerUpdateBase64("stranger") },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a missing/empty update body with 400", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("docroutes-owner-6");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();

    const missing = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/doc/updates`,
      headers: { cookie },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const empty = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/doc/updates`,
      headers: { cookie },
      payload: { update: "" },
    });
    expect(empty.statusCode).toBe(400);

    await app.close();
  });

  it("multiple pushes accumulate as separate rows and all merge on load (O(change) writes, not O(document) rewrites)", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("docroutes-multi-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();

    // Three pushes, each setting a different key — order-independent, so
    // this doesn't depend on Yjs's concurrent-write tie-breaking (see
    // docStorage.test.ts's comment on `singleMarkerUpdate` for why that
    // matters when asserting "last write wins" instead).
    for (const key of ["alpha", "beta", "gamma"]) {
      const doc = new Y.Doc();
      doc.transact(() => doc.getMap("meta").set(key, true));
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/doc/updates`,
        headers: { cookie },
        payload: { update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") },
      });
    }

    const rows = await db.selectFrom("project_doc_updates").selectAll().where("project_id", "=", project.id).execute();
    expect(rows).toHaveLength(3);
    // Each row is small (one key's worth of change) — not a full-document
    // rewrite that would grow with unrelated content.
    for (const row of rows) {
      expect(row.update.length).toBeLessThan(200);
    }

    const getRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}/doc`, headers: { cookie } });
    const merged = new Y.Doc();
    Y.applyUpdate(merged, Buffer.from(getRes.json().update, "base64"));
    expect(merged.getMap("meta").get("alpha")).toBe(true);
    expect(merged.getMap("meta").get("beta")).toBe(true);
    expect(merged.getMap("meta").get("gamma")).toBe(true);

    await app.close();
  });
});
