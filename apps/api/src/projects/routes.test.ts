import crypto from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createSession, SESSION_COOKIE_NAME } from "../auth/session.js";
import { buildApp } from "../app.js";
import { closeDb, db } from "../db.js";

// These tests hit a real Postgres connection (DATABASE_URL), same precedent
// as auth/routes.test.ts and auth/users.test.ts. Each test creates its own
// users with randomly generated discord_ids so tests can run concurrently
// without colliding.

afterAll(async () => {
  await closeDb();
});

/** Inserts a `users` row directly (bypassing the Discord flow entirely — Job 006 doesn't need it). */
async function createTestUser(username: string) {
  return db
    .insertInto("users")
    .values({ discord_id: `test-${crypto.randomUUID()}`, username })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Creates a real session row for `userId` and returns a `Cookie` header value carrying it. */
async function cookieFor(userId: string): Promise<string> {
  const { token } = await createSession({ userId });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

describe("POST /api/projects", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("creates a project owned by the caller, with a default title and a unique short_id", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("owner-1");
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.title).toBe("My Factory");
    expect(body.ownerId).toBe(owner.id);
    expect(body.role).toBe("owner");
    expect(body.shortId).toBeTruthy();

    // An `owner` project_members row was inserted alongside the project.
    const member = await db
      .selectFrom("project_members")
      .selectAll()
      .where("project_id", "=", body.id)
      .where("user_id", "=", owner.id)
      .executeTakeFirst();
    expect(member?.role).toBe("owner");

    await app.close();
  });

  it("accepts a custom title", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("owner-2");
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { title: "My Factory" },
    });
    expect(res.json().title).toBe("My Factory");
    await app.close();
  });

  it("generates distinct short_ids across projects", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("owner-3");
    const cookie = await cookieFor(owner.id);

    const first = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const second = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    expect(first.json().shortId).not.toBe(second.json().shortId);

    await app.close();
  });
});

describe("GET /api/projects", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("lists owned and shared projects, but not projects the caller isn't a member of, and excludes soft-deleted ones", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();

    const owner = await createTestUser("list-owner");
    const collaborator = await createTestUser("list-collaborator");
    const stranger = await createTestUser("list-stranger");
    const ownerCookie = await cookieFor(owner.id);
    const collaboratorCookie = await cookieFor(collaborator.id);
    const strangerCookie = await cookieFor(stranger.id);

    // Owner creates two projects.
    const ownedRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
      payload: { title: "Owned Project" },
    });
    const ownedProject = ownedRes.json();

    const toDeleteRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
      payload: { title: "Will Be Deleted" },
    });
    const toDeleteProject = toDeleteRes.json();

    // Share the first project with the collaborator as a viewer.
    await db
      .insertInto("project_members")
      .values({ project_id: ownedProject.id, user_id: collaborator.id, role: "viewer" })
      .execute();

    // Soft-delete the second project.
    await app.inject({
      method: "DELETE",
      url: `/api/projects/${toDeleteProject.id}`,
      headers: { cookie: ownerCookie },
    });

    // Owner sees only the non-deleted owned project.
    const ownerList = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const ownerIds = ownerList.json().map((p: { id: string }) => p.id);
    expect(ownerIds).toContain(ownedProject.id);
    expect(ownerIds).not.toContain(toDeleteProject.id);

    // Collaborator sees the shared project with role "viewer".
    const collaboratorList = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: collaboratorCookie },
    });
    const collaboratorProjects = collaboratorList.json();
    const shared = collaboratorProjects.find((p: { id: string }) => p.id === ownedProject.id);
    expect(shared).toBeDefined();
    expect(shared.role).toBe("viewer");

    // Stranger (non-member) sees neither project.
    const strangerList = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: strangerCookie },
    });
    const strangerIds = strangerList.json().map((p: { id: string }) => p.id);
    expect(strangerIds).not.toContain(ownedProject.id);
    expect(strangerIds).not.toContain(toDeleteProject.id);

    await app.close();
  });
});

describe("PATCH /api/projects/:id — role enforcement", () => {
  it("lets the owner rename, and the rename persists", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("patch-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
    });
    const project = createRes.json();

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: { cookie },
      payload: { title: "Renamed Factory" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().title).toBe("Renamed Factory");

    // Persists across a fresh read (simulating a page refresh).
    const listRes = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    const found = listRes.json().find((p: { id: string }) => p.id === project.id);
    expect(found.title).toBe("Renamed Factory");

    await app.close();
  });

  it("lets an editor rename", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("patch-owner-2");
    const editor = await createTestUser("patch-editor");
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const project = createRes.json();
    await db
      .insertInto("project_members")
      .values({ project_id: project.id, user_id: editor.id, role: "editor" })
      .execute();

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: { cookie: editorCookie },
      payload: { title: "Edited By Editor" },
    });
    expect(patchRes.statusCode).toBe(200);

    await app.close();
  });

  it("forbids a viewer from renaming (403)", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("patch-owner-3");
    const viewer = await createTestUser("patch-viewer");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const project = createRes.json();
    await db
      .insertInto("project_members")
      .values({ project_id: project.id, user_id: viewer.id, role: "viewer" })
      .execute();

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: { cookie: viewerCookie },
      payload: { title: "Should Not Apply" },
    });
    expect(patchRes.statusCode).toBe(403);

    // Title unchanged.
    const listRes = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const found = listRes.json().find((p: { id: string }) => p.id === project.id);
    expect(found.title).toBe("My Factory");

    await app.close();
  });

  it("returns 404 for a non-member acting on a project (does not leak existence)", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("patch-owner-4");
    const stranger = await createTestUser("patch-stranger");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const project = createRes.json();

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: { cookie: strangerCookie },
      payload: { title: "Hijacked" },
    });
    expect(patchRes.statusCode).toBe(404);

    await app.close();
  });

  it("returns 404 for a nonexistent project id", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("patch-owner-5");
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${crypto.randomUUID()}`,
      headers: { cookie },
      payload: { title: "Ghost" },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("rejects an empty title with 400", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("patch-owner-6");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
    });
    const project = createRes.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: { cookie },
      payload: { title: "   " },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

describe("DELETE /api/projects/:id — owner-only soft delete", () => {
  it("lets the owner soft-delete: it disappears from the list but remains in the database", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("delete-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
    });
    const project = createRes.json();

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      headers: { cookie },
    });
    expect(deleteRes.statusCode).toBe(204);

    const listRes = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(listRes.json().map((p: { id: string }) => p.id)).not.toContain(project.id);

    const row = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", project.id)
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row?.deleted_at).not.toBeNull();

    await app.close();
  });

  it("forbids an editor from deleting (403)", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("delete-owner-2");
    const editor = await createTestUser("delete-editor");
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const project = createRes.json();
    await db
      .insertInto("project_members")
      .values({ project_id: project.id, user_id: editor.id, role: "editor" })
      .execute();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      headers: { cookie: editorCookie },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it("forbids a viewer from deleting (403)", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("delete-owner-3");
    const viewer = await createTestUser("delete-viewer");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const project = createRes.json();
    await db
      .insertInto("project_members")
      .values({ project_id: project.id, user_id: viewer.id, role: "viewer" })
      .execute();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it("returns 404 for a non-member", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("delete-owner-4");
    const stranger = await createTestUser("delete-stranger");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const project = createRes.json();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      headers: { cookie: strangerCookie },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe("POST /api/projects/:id/duplicate — full clone (Job 015: metadata + doc content)", () => {
  it("clones the project row with a new id/short_id, '(copy)' title suffix, and owner_id set to the duplicator", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("dup-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { title: "Original" },
    });
    const original = createRes.json();

    const dupRes = await app.inject({
      method: "POST",
      url: `/api/projects/${original.id}/duplicate`,
      headers: { cookie },
    });
    expect(dupRes.statusCode).toBe(201);
    const copy = dupRes.json();

    expect(copy.id).not.toBe(original.id);
    expect(copy.shortId).not.toBe(original.shortId);
    expect(copy.title).toBe("Original (copy)");
    expect(copy.ownerId).toBe(owner.id);
    expect(copy.role).toBe("owner");
    // Job 006's `metadataOnly: true` flag is gone (Job 015 made duplication
    // a real, full clone) — assert it's simply absent from the response.
    expect(copy.metadataOnly).toBeUndefined();

    // The original project is untouched.
    const originalRow = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", original.id)
      .executeTakeFirst();
    expect(originalRow?.title).toBe("Original");

    await app.close();
  });

  it("duplicates the source project's current canvas document content, not just its metadata row", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("dup-doc-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { title: "Has Doc Content" },
    });
    const original = createRes.json();

    // Push a doc update carrying a distinctive marker into the source
    // project's document, exactly the way `apps/web`'s debounced push does.
    const sourceDoc = new Y.Doc();
    sourceDoc.transact(() => {
      sourceDoc.getMap("meta").set("distinctiveMarker", "job-015-dup-test");
    });
    const pushRes = await app.inject({
      method: "POST",
      url: `/api/projects/${original.id}/doc/updates`,
      headers: { cookie },
      payload: { update: Buffer.from(Y.encodeStateAsUpdate(sourceDoc)).toString("base64") },
    });
    expect(pushRes.statusCode).toBe(204);

    const dupRes = await app.inject({
      method: "POST",
      url: `/api/projects/${original.id}/duplicate`,
      headers: { cookie },
    });
    expect(dupRes.statusCode).toBe(201);
    const copy = dupRes.json();

    const docRes = await app.inject({
      method: "GET",
      url: `/api/projects/${copy.id}/doc`,
      headers: { cookie },
    });
    expect(docRes.statusCode).toBe(200);
    const copiedDoc = new Y.Doc();
    Y.applyUpdate(copiedDoc, Buffer.from(docRes.json().update, "base64"));
    expect(copiedDoc.getMap("meta").get("distinctiveMarker")).toBe("job-015-dup-test");

    await app.close();
  });

  it("lets a viewer duplicate — the duplicator becomes the owner of a brand-new project, the source is untouched", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("dup-owner-2");
    const viewer = await createTestUser("dup-viewer");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const original = createRes.json();
    await db
      .insertInto("project_members")
      .values({ project_id: original.id, user_id: viewer.id, role: "viewer" })
      .execute();

    const dupRes = await app.inject({
      method: "POST",
      url: `/api/projects/${original.id}/duplicate`,
      headers: { cookie: viewerCookie },
    });
    expect(dupRes.statusCode).toBe(201);
    expect(dupRes.json().ownerId).toBe(viewer.id);

    await app.close();
  });

  it("returns 404 for a non-member trying to duplicate", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("dup-owner-3");
    const stranger = await createTestUser("dup-stranger");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ownerCookie },
    });
    const original = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${original.id}/duplicate`,
      headers: { cookie: strangerCookie },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
