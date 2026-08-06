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

/**
 * Same rationale as `docStorage.test.ts`'s `createMarkerEditor`: two
 * *independent* one-shot docs each setting the same key are truly
 * concurrent from Yjs's point of view (no defined "latest wins"), so a test
 * asserting a specific sequence of writes to the same key must chain them
 * through one evolving `Y.Doc`, exactly like a real client's `doc.on
 * ('update', ...)` listener would.
 */
function createMarkerEditor() {
  const doc = new Y.Doc();
  let priorStateVector = Y.encodeStateVector(doc);
  return {
    setMarkerBase64(value: string): string {
      doc.transact(() => doc.getMap("meta").set("marker", value));
      const update = Y.encodeStateAsUpdate(doc, priorStateVector);
      priorStateVector = Y.encodeStateVector(doc);
      return Buffer.from(update).toString("base64");
    },
  };
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

describe("GET /api/projects/:id/versions", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/api/projects/${crypto.randomUUID()}/versions` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 for a non-member", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-owner-1");
    const stranger = await createTestUser("versionroutes-stranger-1");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/versions`, headers: { cookie: strangerCookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("lets a viewer list versions (read-only)", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-owner-2");
    const viewer = await createTestUser("versionroutes-viewer-1");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();

    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/versions`,
      headers: { cookie: ownerCookie },
      payload: { label: "Owner's save" },
    });

    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/versions`, headers: { cookie: viewerCookie } });
    expect(res.statusCode).toBe(200);
    const versions = res.json();
    expect(versions).toHaveLength(1);
    expect(versions[0].label).toBe("Owner's save");
    expect(versions[0].kind).toBe("manual");
    expect(typeof versions[0].createdAt).toBe("string");

    await app.close();
  });

  it("returns an empty list for a project with no versions yet", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-empty-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/versions`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });
});

describe("POST /api/projects/:id/versions", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "POST", url: `/api/projects/${crypto.randomUUID()}/versions` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("creates a manual version as the owner, with a trimmed label", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-manual-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/doc/updates`,
      headers: { cookie },
      payload: { update: markerUpdateBase64("manual-save-content") },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/versions`,
      headers: { cookie },
      payload: { label: "  My Checkpoint  " },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.kind).toBe("manual");
    expect(body.label).toBe("My Checkpoint");
    expect(body.createdBy).toBe(owner.id);

    const doc = new Y.Doc();
    const bytesRow = await db.selectFrom("project_versions").select(["ydoc"]).where("id", "=", body.id).executeTakeFirstOrThrow();
    Y.applyUpdate(doc, bytesRow.ydoc);
    expect(doc.getMap("meta").get("marker")).toBe("manual-save-content");

    await app.close();
  });

  it("treats a missing/blank label as unlabeled", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-nolabel-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/versions`,
      headers: { cookie },
      payload: { label: "   " },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().label).toBeNull();

    await app.close();
  });

  it("rejects a viewer with 403", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-owner-3");
    const viewer = await createTestUser("versionroutes-viewer-2");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/versions`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);

    const versions = await db.selectFrom("project_versions").selectAll().where("project_id", "=", project.id).execute();
    expect(versions).toHaveLength(0);

    await app.close();
  });

  it("returns 404 for a non-member", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-owner-4");
    const stranger = await createTestUser("versionroutes-stranger-2");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/versions`,
      headers: { cookie: strangerCookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/projects/:id/versions/:versionId/restore", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${crypto.randomUUID()}/versions/${crypto.randomUUID()}/restore`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("end-to-end: state A -> save version -> state B -> restore -> canvas shows A, a pre_restore snapshot of B exists", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-restore-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();
    const editor = createMarkerEditor();

    // State A.
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/doc/updates`,
      headers: { cookie },
      payload: { update: editor.setMarkerBase64("state-A") },
    });
    const saveRes = await app.inject({ method: "POST", url: `/api/projects/${project.id}/versions`, headers: { cookie }, payload: { label: "A" } });
    const versionA = saveRes.json();

    // State B (a later, unsaved edit).
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/doc/updates`,
      headers: { cookie },
      payload: { update: editor.setMarkerBase64("state-B") },
    });
    const beforeRestoreGet = await app.inject({ method: "GET", url: `/api/projects/${project.id}/doc`, headers: { cookie } });
    const beforeDoc = new Y.Doc();
    Y.applyUpdate(beforeDoc, Buffer.from(beforeRestoreGet.json().update, "base64"));
    expect(beforeDoc.getMap("meta").get("marker")).toBe("state-B");

    // Restore to A.
    const restoreRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/versions/${versionA.id}/restore`,
      headers: { cookie },
    });
    expect(restoreRes.statusCode).toBe(200);
    const restoreBody = restoreRes.json();
    expect(restoreBody.restoredVersionId).toBe(versionA.id);
    expect(restoreBody.preRestoreVersion.kind).toBe("pre_restore");

    // Canvas shows state A again.
    const afterRestoreGet = await app.inject({ method: "GET", url: `/api/projects/${project.id}/doc`, headers: { cookie } });
    const afterDoc = new Y.Doc();
    Y.applyUpdate(afterDoc, Buffer.from(afterRestoreGet.json().update, "base64"));
    expect(afterDoc.getMap("meta").get("marker")).toBe("state-A");

    // A pre_restore snapshot of state B now exists in the version list.
    const listRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}/versions`, headers: { cookie } });
    const versions = listRes.json() as Array<{ id: string; kind: string }>;
    expect(versions.some((v) => v.id === restoreBody.preRestoreVersion.id && v.kind === "pre_restore")).toBe(true);

    await app.close();
  });

  it("returns 404 for a nonexistent version id", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-restore-missing-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/versions/${crypto.randomUUID()}/restore`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a viewer with 403", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-restore-owner-2");
    const viewer = await createTestUser("versionroutes-restore-viewer");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();
    const saveRes = await app.inject({ method: "POST", url: `/api/projects/${project.id}/versions`, headers: { cookie: ownerCookie } });
    const version = saveRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/versions/${version.id}/restore`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 404 for a non-member", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("versionroutes-restore-owner-3");
    const stranger = await createTestUser("versionroutes-restore-stranger");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    const saveRes = await app.inject({ method: "POST", url: `/api/projects/${project.id}/versions`, headers: { cookie: ownerCookie } });
    const version = saveRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/versions/${version.id}/restore`,
      headers: { cookie: strangerCookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
