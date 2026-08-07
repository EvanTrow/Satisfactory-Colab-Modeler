// Job 020: exercises the real Hocuspocus server end to end against a real
// Postgres connection and real `@hocuspocus/provider` WebSocket clients —
// deliberately bypassing `apps/web`'s UI entirely for the viewer-read-only
// case, per PLAN.md §9's own explicit "write an explicit test that bypasses
// the client UI... and confirms the server rejects the write" requirement.
//
// Test-only env vars are set at module scope, *before* anything imports
// `./server.js` (and transitively `./config.js`) transitively runs its own
// dotenv load — `getRealtimeConfig()` re-reads `process.env` on every call
// (not cached at import time), so setting these here is sufficient; no
// import-order hazard.
process.env.REALTIME_TICKET_SECRET = "test-realtime-ticket-secret";
process.env.REALTIME_INTERNAL_SECRET = "test-realtime-internal-secret";
process.env.REALTIME_PORT = "18234";
process.env.REALTIME_INTERNAL_PORT = "18235";
// Real hourly cadence would never fire during a test run — see the
// dedicated "hourly re-verification sweep" test below, which overrides this
// per-test to something the test can actually wait out.
process.env.REALTIME_REVERIFY_INTERVAL_MS = String(60 * 60 * 1000);
// Hocuspocus's own onStoreDocument debounce defaults (2s/10s) would make
// the "persists an editor's edit" test needlessly slow.
process.env.REALTIME_STORE_DEBOUNCE_MS = "50";
process.env.REALTIME_STORE_MAX_DEBOUNCE_MS = "100";

import crypto from "node:crypto";

import { HocuspocusProvider } from "@hocuspocus/provider";
import { closeDb, db, loadProjectDocUpdate } from "@scm/doc-storage";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createHocuspocusServer, type RealtimeServer } from "./server.js";

const WS_URL = `ws://127.0.0.1:${process.env.REALTIME_PORT}`;
const INTERNAL_URL = `http://127.0.0.1:${process.env.REALTIME_INTERNAL_PORT}`;

let realtime: RealtimeServer;
const openProviders: HocuspocusProvider[] = [];

beforeAll(async () => {
  realtime = await createHocuspocusServer();
});

afterAll(async () => {
  await realtime.stop();
  await closeDb();
});

afterEach(() => {
  for (const provider of openProviders.splice(0)) {
    provider.destroy();
  }
});

function trackProvider(provider: HocuspocusProvider): HocuspocusProvider {
  openProviders.push(provider);
  return provider;
}

async function createTestUser(username: string) {
  return db
    .insertInto("users")
    .values({ discord_id: `test-${crypto.randomUUID()}`, username })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Inserts a bare `projects` row *and* the owner's `project_members` row —
 * unlike `@scm/doc-storage`'s own tests (which operate below the role
 * layer and don't need one), every test here connects through
 * `onAuthenticate`, which resolves roles from `project_members` — so a
 * project with no owner membership row would make even the *owner*'s own
 * ticket fail to authenticate, same as a real non-member's would.
 */
async function createTestProject(ownerId: string) {
  const project = await db
    .insertInto("projects")
    .values({ short_id: crypto.randomUUID(), owner_id: ownerId, game_data_version: "test" })
    .returningAll()
    .executeTakeFirstOrThrow();
  await addMember(project.id, ownerId, "owner");
  return project;
}

async function addMember(projectId: string, userId: string, role: "owner" | "editor" | "viewer") {
  await db.insertInto("project_members").values({ project_id: projectId, user_id: userId, role }).execute();
}

/** Mints a ticket the same shape `apps/api/src/realtime/ticket.ts` mints — duplicated here deliberately (see that module's own header comment on why the ticket logic isn't shared across apps). */
function mintTicket(input: {
  sub: string;
  projectId: string;
  role: "owner" | "editor" | "viewer";
  expiresInSeconds?: number;
  secret?: string;
}): string {
  return jwt.sign(
    { sub: input.sub, projectId: input.projectId, role: input.role, jti: crypto.randomUUID() },
    input.secret ?? process.env.REALTIME_TICKET_SECRET!,
    { algorithm: "HS256", expiresIn: input.expiresInSeconds ?? 60 },
  );
}

/** Opens a raw provider connection (no client UI involved at all) and waits for it to either authenticate or fail authenticating. */
function connect(projectId: string, ticket: string): { provider: HocuspocusProvider; authenticated: Promise<void>; authFailed: Promise<{ reason: string }> } {
  let resolveAuthenticated: () => void;
  let resolveFailed: (v: { reason: string }) => void;
  const authenticated = new Promise<void>((resolve) => {
    resolveAuthenticated = resolve;
  });
  const authFailed = new Promise<{ reason: string }>((resolve) => {
    resolveFailed = resolve;
  });

  const provider = trackProvider(
    new HocuspocusProvider({
      url: WS_URL,
      name: projectId,
      token: ticket,
      document: new Y.Doc(),
      onAuthenticated: () => resolveAuthenticated(),
      onAuthenticationFailed: (data) => resolveFailed(data),
    }),
  );

  return { provider, authenticated, authFailed };
}

function waitForClose(provider: HocuspocusProvider, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for the connection to close")), timeoutMs);
    provider.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function notifyMembershipChanged(projectId: string, userId?: string): Promise<Response> {
  return fetch(`${INTERNAL_URL}/internal/membership-changed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": process.env.REALTIME_INTERNAL_SECRET! },
    body: JSON.stringify({ projectId, userId }),
  });
}

describe("onAuthenticate: ticket validation", () => {
  it("rejects a ticket signed with the wrong secret", async () => {
    const owner = await createTestUser("realtime-badsig-owner");
    const project = await createTestProject(owner.id);
    const ticket = mintTicket({ sub: owner.id, projectId: project.id, role: "owner", secret: "not-the-real-secret" });

    const { authFailed, authenticated } = connect(project.id, ticket);
    const result = await Promise.race([authFailed, authenticated.then(() => "authenticated" as const)]);
    expect(result).not.toBe("authenticated");
  });

  it("rejects an expired ticket", async () => {
    const owner = await createTestUser("realtime-expired-owner");
    const project = await createTestProject(owner.id);
    const ticket = mintTicket({ sub: owner.id, projectId: project.id, role: "owner", expiresInSeconds: -5 });

    const { authFailed, authenticated } = connect(project.id, ticket);
    const result = await Promise.race([authFailed, authenticated.then(() => "authenticated" as const)]);
    expect(result).not.toBe("authenticated");
  });

  it("rejects a ticket minted for a different project", async () => {
    const owner = await createTestUser("realtime-wrongproject-owner");
    const projectA = await createTestProject(owner.id);
    const projectB = await createTestProject(owner.id);
    const ticket = mintTicket({ sub: owner.id, projectId: projectA.id, role: "owner" });

    // Connecting to projectB's document with a ticket minted for projectA.
    const { authFailed, authenticated } = connect(projectB.id, ticket);
    const result = await Promise.race([authFailed, authenticated.then(() => "authenticated" as const)]);
    expect(result).not.toBe("authenticated");
  });

  it("rejects a structurally-valid ticket for a user who is no longer a project member", async () => {
    const owner = await createTestUser("realtime-nomember-owner");
    const stranger = await createTestUser("realtime-nomember-stranger");
    const project = await createTestProject(owner.id);
    // stranger has no project_members row at all.
    const ticket = mintTicket({ sub: stranger.id, projectId: project.id, role: "editor" });

    const { authFailed, authenticated } = connect(project.id, ticket);
    const result = await Promise.race([authFailed, authenticated.then(() => "authenticated" as const)]);
    expect(result).not.toBe("authenticated");
  });

  it("accepts a valid ticket for a real member", async () => {
    const owner = await createTestUser("realtime-valid-owner");
    const project = await createTestProject(owner.id);
    const ticket = mintTicket({ sub: owner.id, projectId: project.id, role: "owner" });

    const { authenticated, authFailed } = connect(project.id, ticket);
    const result = await Promise.race([authenticated.then(() => "authenticated" as const), authFailed]);
    expect(result).toBe("authenticated");
  });
});

describe("viewer read-only enforcement (PLAN.md §9's explicit acceptance criterion)", () => {
  it("drops a viewer's write server-side — the persisted document is unchanged, not merely hidden client-side", async () => {
    const owner = await createTestUser("realtime-viewerwrite-owner");
    const viewer = await createTestUser("realtime-viewerwrite-viewer");
    const project = await createTestProject(owner.id);
    await addMember(project.id, viewer.id, "viewer");

    // Establish a known baseline: the owner writes a marker first, over a
    // real (non-bypassed-role) editor connection, so there is real content
    // whose *absence of change* the viewer-write attempt can be checked
    // against — not just "the doc is empty," which a broken load path
    // could also produce.
    const ownerTicket = mintTicket({ sub: owner.id, projectId: project.id, role: "owner" });
    const { provider: ownerProvider, authenticated: ownerAuthenticated } = connect(project.id, ownerTicket);
    await ownerAuthenticated;
    ownerProvider.document.transact(() => ownerProvider.document.getMap("meta").set("marker", "owner-baseline"));
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the store debounce (50/100ms) flush
    ownerProvider.destroy();

    // Now connect as the viewer — a raw provider, no client UI whatsoever —
    // and attempt a real write.
    const viewerTicket = mintTicket({ sub: viewer.id, projectId: project.id, role: "viewer" });
    const { provider: viewerProvider, authenticated: viewerAuthenticated } = connect(project.id, viewerTicket);
    await viewerAuthenticated;
    expect(viewerProvider.authorizedScope).toBe("readonly");

    viewerProvider.document.transact(() => viewerProvider.document.getMap("meta").set("marker", "viewer-should-not-persist"));
    // Wait comfortably longer than the (overridden, short) store debounce —
    // if the write were ever applied server-side, this is enough time for
    // onStoreDocument to have persisted it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    viewerProvider.destroy();

    const bytes = await loadProjectDocUpdate(project.id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    expect(doc.getMap("meta").get("marker")).toBe("owner-baseline");
  });
});

describe("two editors converge (basic 2-client happy path, ahead of Job 021's presence UI)", () => {
  it("propagates one editor's edit to a second editor connected to the same project", async () => {
    const owner = await createTestUser("realtime-twoeditor-owner");
    const editor = await createTestUser("realtime-twoeditor-editor");
    const project = await createTestProject(owner.id);
    await addMember(project.id, editor.id, "editor");

    const ticketA = mintTicket({ sub: owner.id, projectId: project.id, role: "owner" });
    const ticketB = mintTicket({ sub: editor.id, projectId: project.id, role: "editor" });

    const { provider: providerA, authenticated: authA } = connect(project.id, ticketA);
    const { provider: providerB, authenticated: authB } = connect(project.id, ticketB);
    await Promise.all([authA, authB]);

    providerA.document.transact(() => providerA.document.getMap("meta").set("title", "hello from A"));

    await new Promise<void>((resolve) => {
      const check = () => {
        if (providerB.document.getMap("meta").get("title") === "hello from A") resolve();
      };
      providerB.document.on("update", check);
      check();
    });

    expect(providerB.document.getMap("meta").get("title")).toBe("hello from A");
  });
});

describe("revocation", () => {
  it("force-disconnects a member's active session when a role change is pushed via the internal webhook", async () => {
    const owner = await createTestUser("realtime-revoke-owner");
    const editor = await createTestUser("realtime-revoke-editor");
    const project = await createTestProject(owner.id);
    await addMember(project.id, editor.id, "editor");

    const ticket = mintTicket({ sub: editor.id, projectId: project.id, role: "editor" });
    const { provider, authenticated } = connect(project.id, ticket);
    await authenticated;

    const closed = waitForClose(provider);

    // The real membership change (an owner "revoking" the editor down to a
    // viewer — same effect on the connection as an outright removal, since
    // its authenticated role no longer matches).
    await db.updateTable("project_members").set({ role: "viewer" }).where("project_id", "=", project.id).where("user_id", "=", editor.id).execute();
    const res = await notifyMembershipChanged(project.id, editor.id);
    expect(res.status).toBe(204);

    await closed; // throws (test fails) if this doesn't happen within the timeout
  });

  it("force-disconnects on outright removal, not just a role change", async () => {
    const owner = await createTestUser("realtime-remove-owner");
    const viewer = await createTestUser("realtime-remove-viewer");
    const project = await createTestProject(owner.id);
    await addMember(project.id, viewer.id, "viewer");

    const ticket = mintTicket({ sub: viewer.id, projectId: project.id, role: "viewer" });
    const { provider, authenticated } = connect(project.id, ticket);
    await authenticated;

    const closed = waitForClose(provider);

    await db.deleteFrom("project_members").where("project_id", "=", project.id).where("user_id", "=", viewer.id).execute();
    await notifyMembershipChanged(project.id, viewer.id);

    await closed;
  });

  it("rejects a webhook call with the wrong internal secret", async () => {
    const owner = await createTestUser("realtime-badsecret-owner");
    const project = await createTestProject(owner.id);

    const res = await fetch(`${INTERNAL_URL}/internal/membership-changed`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": "wrong-secret" },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(res.status).toBe(401);
  });

  it("the hourly re-verification sweep also force-disconnects a stale role, independent of the push webhook", async () => {
    // A second server instance, on different ports, with a near-instant
    // sweep interval — isolated from the module-level `realtime` instance
    // (whose interval is the real ~1-hour cadence) so this test doesn't
    // have to wait an hour, without affecting any other test's timing.
    process.env.REALTIME_PORT = "18236";
    process.env.REALTIME_INTERNAL_PORT = "18237";
    process.env.REALTIME_REVERIFY_INTERVAL_MS = "150";
    const sweepServer = await createHocuspocusServer();
    process.env.REALTIME_PORT = "18234";
    process.env.REALTIME_INTERNAL_PORT = "18235";
    process.env.REALTIME_REVERIFY_INTERVAL_MS = String(60 * 60 * 1000);

    try {
      const owner = await createTestUser("realtime-sweep-owner");
      const editor = await createTestUser("realtime-sweep-editor");
      const project = await createTestProject(owner.id);
      await addMember(project.id, editor.id, "editor");

      const ticket = mintTicket({ sub: editor.id, projectId: project.id, role: "editor" });
      const provider = trackProvider(
        new HocuspocusProvider({ url: "ws://127.0.0.1:18236", name: project.id, token: ticket, document: new Y.Doc() }),
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("never authenticated")), 5000);
        provider.on("authenticated", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      const closed = waitForClose(provider, 5000);
      // No webhook call at all — only the DB row changes, so the *only*
      // thing that can notice is the periodic sweep.
      await db.updateTable("project_members").set({ role: "viewer" }).where("project_id", "=", project.id).where("user_id", "=", editor.id).execute();

      await closed;
    } finally {
      await sweepServer.stop();
    }
  });
});
