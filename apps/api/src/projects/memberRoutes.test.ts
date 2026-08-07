import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session.js";
import { closeDb, db } from "../db.js";

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

describe("GET /api/projects/:id/members", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/api/projects/${crypto.randomUUID()}/members` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("lists every member, viewable by any member including a viewer", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-list-owner");
    const viewer = await createTestUser("memberroutes-list-viewer");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();

    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/members`, headers: { cookie: viewerCookie } });
    expect(res.statusCode).toBe(200);
    const members = res.json() as Array<{ userId: string; role: string; username: string }>;
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.userId === owner.id)?.role).toBe("owner");
    expect(members.find((m) => m.userId === viewer.id)?.role).toBe("viewer");

    await app.close();
  });

  it("returns 404 for a non-member", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-list-nonmember-owner");
    const stranger = await createTestUser("memberroutes-list-nonmember-stranger");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/members`, headers: { cookie: strangerCookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("PATCH /api/projects/:id/members/:userId", () => {
  it("lets the owner change an editor's role to viewer", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-patch-owner");
    const editor = await createTestUser("memberroutes-patch-editor");
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: editor.id, role: "editor" }).execute();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/members/${editor.id}`,
      headers: { cookie: ownerCookie },
      payload: { role: "viewer" },
    });
    expect(res.statusCode).toBe(204);

    const row = await db
      .selectFrom("project_members")
      .select("role")
      .where("project_id", "=", project.id)
      .where("user_id", "=", editor.id)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("viewer");

    await app.close();
  });

  it("rejects a non-owner (editor/viewer) trying to change a role", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-patch-forbidden-owner");
    const editor = await createTestUser("memberroutes-patch-forbidden-editor");
    const other = await createTestUser("memberroutes-patch-forbidden-other");
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: editor.id, role: "editor" }).execute();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: other.id, role: "viewer" }).execute();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/members/${other.id}`,
      headers: { cookie: editorCookie },
      payload: { role: "editor" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects changing the project's own owner", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-patch-selfowner");
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/members/${owner.id}`,
      headers: { cookie: ownerCookie },
      payload: { role: "viewer" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an invalid role value", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-patch-invalidrole-owner");
    const editor = await createTestUser("memberroutes-patch-invalidrole-editor");
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: editor.id, role: "editor" }).execute();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/members/${editor.id}`,
      headers: { cookie: ownerCookie },
      payload: { role: "owner" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 when the target user isn't a member of this project", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-patch-notmember-owner");
    const stranger = await createTestUser("memberroutes-patch-notmember-stranger");
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/members/${stranger.id}`,
      headers: { cookie: ownerCookie },
      payload: { role: "viewer" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("DELETE /api/projects/:id/members/:userId", () => {
  it("lets the owner remove a member", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-delete-owner");
    const viewer = await createTestUser("memberroutes-delete-viewer");
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/members/${viewer.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(204);

    const row = await db
      .selectFrom("project_members")
      .selectAll()
      .where("project_id", "=", project.id)
      .where("user_id", "=", viewer.id)
      .executeTakeFirst();
    expect(row).toBeUndefined();

    await app.close();
  });

  it("rejects removing the project's own owner", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-delete-selfowner");
    const ownerCookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/members/${owner.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-owner removing a member", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("memberroutes-delete-forbidden-owner");
    const viewer = await createTestUser("memberroutes-delete-forbidden-viewer");
    const other = await createTestUser("memberroutes-delete-forbidden-other");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: other.id, role: "viewer" }).execute();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/members/${other.id}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
