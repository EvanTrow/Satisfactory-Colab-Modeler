import crypto from "node:crypto";

import jwt from "jsonwebtoken";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session.js";
import { closeDb, db } from "../db.js";
import { getRealtimeTicketSecret } from "../realtime/config.js";

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

describe("GET /api/realtime/ticket", () => {
  it("requires auth", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/api/realtime/ticket?projectId=${crypto.randomUUID()}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("requires a projectId query param", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("realtimeroute-noprojectid-owner");
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({ method: "GET", url: "/api/realtime/ticket", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for a non-member (does not leak project existence)", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("realtimeroute-owner-1");
    const stranger = await createTestUser("realtimeroute-stranger-1");
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/realtime/ticket?projectId=${project.id}`,
      headers: { cookie: strangerCookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("mints a 60-second HS256 ticket with { sub, projectId, role, jti } for the owner", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("realtimeroute-mint-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/realtime/ticket?projectId=${project.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expiresInSeconds).toBe(60);
    expect(body.role).toBe("owner");
    expect(typeof body.ticket).toBe("string");

    const decoded = jwt.verify(body.ticket, getRealtimeTicketSecret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    expect(decoded.sub).toBe(owner.id);
    expect(decoded.projectId).toBe(project.id);
    expect(decoded.role).toBe("owner");
    expect(typeof decoded.jti).toBe("string");
    // exp - iat should be exactly the 60-second TTL.
    expect(decoded.exp! - decoded.iat!).toBe(60);

    await app.close();
  });

  it("mints a ticket carrying the caller's real role for a viewer, not the owner's", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("realtimeroute-viewer-owner");
    const viewer = await createTestUser("realtimeroute-viewer-1");
    const ownerCookie = await cookieFor(owner.id);
    const viewerCookie = await cookieFor(viewer.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: ownerCookie } });
    const project = createRes.json();
    await db.insertInto("project_members").values({ project_id: project.id, user_id: viewer.id, role: "viewer" }).execute();

    const res = await app.inject({
      method: "GET",
      url: `/api/realtime/ticket?projectId=${project.id}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe("viewer");

    const decoded = jwt.verify(body.ticket, getRealtimeTicketSecret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    expect(decoded.role).toBe("viewer");
    expect(decoded.sub).toBe(viewer.id);

    await app.close();
  });

  it("returns 404 for a soft-deleted project even for its former owner", async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const owner = await createTestUser("realtimeroute-deleted-owner");
    const cookie = await cookieFor(owner.id);

    const createRes = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie } });
    const project = createRes.json();
    await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers: { cookie } });

    const res = await app.inject({
      method: "GET",
      url: `/api/realtime/ticket?projectId=${project.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
