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

async function createTestProject(ownerCookie: string) {
  const app = await buildApp({ logger: false });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
  const project = res.json();
  await app.close();
  return project;
}

describe("POST /api/projects/:id/invites", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "POST", url: `/api/projects/${crypto.randomUUID()}/invites` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("lets the owner create an invite and returns the raw token exactly once", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-create-owner");
    const ownerCookie = await cookieFor(owner.id);
    const project = await createTestProject(ownerCookie);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "editor" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.role).toBe("editor");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.uses).toBe(0);
    expect(body.maxUses).toBeNull();
    expect(body.expiresAt).toBeNull();

    // The token is never persisted in plaintext, and never comes back from
    // the list route.
    const listRes = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
    });
    const invites = listRes.json();
    expect(invites).toHaveLength(1);
    expect(invites[0]).not.toHaveProperty("token");
    expect(invites[0]).not.toHaveProperty("tokenHash");

    await app.close();
  });

  it("rejects a non-owner", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-create-forbidden-owner");
    const editor = await createTestUser("invites-create-forbidden-editor");
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);
    const project = await createTestProject(ownerCookie);
    await db.insertInto("project_members").values({ project_id: project.id, user_id: editor.id, role: "editor" }).execute();

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: editorCookie },
      payload: { role: "viewer" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects an invalid role", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-create-invalidrole-owner");
    const ownerCookie = await cookieFor(owner.id);
    const project = await createTestProject(ownerCookie);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "owner" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts expiresAt and maxUses", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-create-expiry-owner");
    const ownerCookie = await cookieFor(owner.id);
    const project = await createTestProject(ownerCookie);

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "viewer", expiresAt, maxUses: 3 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.maxUses).toBe(3);
    expect(new Date(body.expiresAt).getTime()).toBeCloseTo(new Date(expiresAt).getTime(), -2);

    await app.close();
  });
});

describe("DELETE /api/projects/:id/invites/:inviteId", () => {
  it("lets the owner revoke an invite, after which it can no longer be redeemed", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-revoke-owner");
    const redeemer = await createTestUser("invites-revoke-redeemer");
    const ownerCookie = await cookieFor(owner.id);
    const redeemerCookie = await cookieFor(redeemer.id);
    const project = await createTestProject(ownerCookie);

    const createRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "editor" },
    });
    const invite = createRes.json();

    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/invites/${invite.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(revokeRes.statusCode).toBe(204);

    const redeemRes = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.token}/redeem`,
      headers: { cookie: redeemerCookie },
    });
    expect(redeemRes.statusCode).toBe(410);

    await app.close();
  });

  it("rejects a non-owner revoking", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-revoke-forbidden-owner");
    const viewer = await createTestUser("invites-revoke-forbidden-viewer");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);
    const project = await createTestProject(ownerCookie);
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "editor" },
    });
    const invite = createRes.json();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/invites/${invite.id}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/invites/:token", () => {
  it("returns a public preview with no auth required", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-preview-owner");
    const ownerCookie = await cookieFor(owner.id);
    const project = await createTestProject(ownerCookie);

    const createRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "viewer" },
    });
    const invite = createRes.json();

    const res = await app.inject({ method: "GET", url: `/api/invites/${invite.token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.projectId).toBe(project.id);
    expect(body.role).toBe("viewer");

    await app.close();
  });

  it("reports an unknown token as invalid rather than erroring", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/invites/not-a-real-token" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false, reason: "not_found" });
    await app.close();
  });
});

describe("POST /api/invites/:token/redeem", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/invites/some-token/redeem" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("grants the invite's configured role to a redeeming user", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-redeem-owner");
    const redeemer = await createTestUser("invites-redeem-redeemer");
    const ownerCookie = await cookieFor(owner.id);
    const redeemerCookie = await cookieFor(redeemer.id);
    const project = await createTestProject(ownerCookie);

    const createRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "editor" },
    });
    const invite = createRes.json();

    const redeemRes = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.token}/redeem`,
      headers: { cookie: redeemerCookie },
    });
    expect(redeemRes.statusCode).toBe(200);
    expect(redeemRes.json()).toEqual({ projectId: project.id, role: "editor", alreadyMember: false });

    const row = await db
      .selectFrom("project_members")
      .selectAll()
      .where("project_id", "=", project.id)
      .where("user_id", "=", redeemer.id)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("editor");

    await app.close();
  });

  it("respects maxUses — a second redemption past the cap is rejected", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-redeem-maxuses-owner");
    const first = await createTestUser("invites-redeem-maxuses-first");
    const second = await createTestUser("invites-redeem-maxuses-second");
    const ownerCookie = await cookieFor(owner.id);
    const firstCookie = await cookieFor(first.id);
    const secondCookie = await cookieFor(second.id);
    const project = await createTestProject(ownerCookie);

    const createRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "viewer", maxUses: 1 },
    });
    const invite = createRes.json();

    const firstRes = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.token}/redeem`,
      headers: { cookie: firstCookie },
    });
    expect(firstRes.statusCode).toBe(200);

    const secondRes = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.token}/redeem`,
      headers: { cookie: secondCookie },
    });
    expect(secondRes.statusCode).toBe(410);
    expect(secondRes.json()).toEqual({ error: "invite_exhausted" });

    await app.close();
  });

  it("respects concurrent redemption of a maxUses:1 invite — exactly one of two simultaneous redeemers wins", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-redeem-race-owner");
    const a = await createTestUser("invites-redeem-race-a");
    const b = await createTestUser("invites-redeem-race-b");
    const ownerCookie = await cookieFor(owner.id);
    const aCookie = await cookieFor(a.id);
    const bCookie = await cookieFor(b.id);
    const project = await createTestProject(ownerCookie);

    const createRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "editor", maxUses: 1 },
    });
    const invite = createRes.json();

    const [resA, resB] = await Promise.all([
      app.inject({ method: "POST", url: `/api/invites/${invite.token}/redeem`, headers: { cookie: aCookie } }),
      app.inject({ method: "POST", url: `/api/invites/${invite.token}/redeem`, headers: { cookie: bCookie } }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    expect(statuses).toEqual([200, 410]);

    const members = await db
      .selectFrom("project_members")
      .selectAll()
      .where("project_id", "=", project.id)
      .where("user_id", "in", [a.id, b.id])
      .execute();
    expect(members).toHaveLength(1);

    await app.close();
  });

  it("respects expiresAt — an already-expired invite is rejected", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-redeem-expired-owner");
    const redeemer = await createTestUser("invites-redeem-expired-redeemer");
    const ownerCookie = await cookieFor(owner.id);
    const redeemerCookie = await cookieFor(redeemer.id);
    const project = await createTestProject(ownerCookie);

    const createRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "viewer", expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    const invite = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.token}/redeem`,
      headers: { cookie: redeemerCookie },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: "invite_expired" });

    await app.close();
  });

  it("does not downgrade an existing member's role when redeeming a lesser invite", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("invites-redeem-nodowngrade-owner");
    const editor = await createTestUser("invites-redeem-nodowngrade-editor");
    const ownerCookie = await cookieFor(owner.id);
    const editorCookie = await cookieFor(editor.id);
    const project = await createTestProject(ownerCookie);
    await db.insertInto("project_members").values({ project_id: project.id, user_id: editor.id, role: "editor" }).execute();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/invites`,
      headers: { cookie: ownerCookie },
      payload: { role: "viewer" },
    });
    const invite = createRes.json();

    const res = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.token}/redeem`,
      headers: { cookie: editorCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyMember).toBe(true);

    const row = await db
      .selectFrom("project_members")
      .select("role")
      .where("project_id", "=", project.id)
      .where("user_id", "=", editor.id)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("editor");

    await app.close();
  });
});
