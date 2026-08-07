// Job 021: real, live Awareness convergence over the real Hocuspocus server
// — the transport-level guarantee `apps/web/src/collab`'s presence UI is
// built on top of. Mirrors `server.test.ts`'s own precedent (real
// `@hocuspocus/provider` clients, real Postgres-backed `project_members`
// roles, no client UI involved at all) but a separate file/port range so it
// can run independently of that file's own server instance and port numbers
// (vitest runs test files in parallel by default — see this file's own
// `REALTIME_PORT`/`REALTIME_INTERNAL_PORT` choice below, deliberately
// disjoint from `server.test.ts`'s 18234-18237).
//
// What this specifically proves, per `jobs/021-presence.md`'s acceptance
// criteria: (1) one client's published Awareness state (cursor/selection/
// editingField) reaches a second, independently-connected client through
// the real server, and (2) closing one client's connection clears its
// Awareness entry from the other client's view with **no manual cleanup
// code anywhere in this repo** — confirming
// `@hocuspocus/server`'s own `Document.removeConnection` (which calls
// `removeAwarenessStates` the moment it notices a socket close) is in fact
// what `apps/web/src/collab/useLocalPresence.ts`'s own header comment
// claims it is, rather than assuming it from reading the library's source
// alone.
process.env.REALTIME_TICKET_SECRET = "test-realtime-ticket-secret";
process.env.REALTIME_INTERNAL_SECRET = "test-realtime-internal-secret";
process.env.REALTIME_PORT = "18244";
process.env.REALTIME_INTERNAL_PORT = "18245";
process.env.REALTIME_REVERIFY_INTERVAL_MS = String(60 * 60 * 1000);
process.env.REALTIME_STORE_DEBOUNCE_MS = "50";
process.env.REALTIME_STORE_MAX_DEBOUNCE_MS = "100";

import crypto from "node:crypto";

import { HocuspocusProvider } from "@hocuspocus/provider";
import { closeDb, db } from "@scm/doc-storage";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createHocuspocusServer, type RealtimeServer } from "./server.js";

const WS_URL = `ws://127.0.0.1:${process.env.REALTIME_PORT}`;

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

/** Same shape as `server.test.ts`'s own `createTestProject` — see that file's header comment for why a real `project_members` row is required for `onAuthenticate` to accept even the owner's own ticket. */
async function createTestProject(ownerId: string) {
  const project = await db
    .insertInto("projects")
    .values({ short_id: crypto.randomUUID(), owner_id: ownerId, game_data_version: "test" })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db.insertInto("project_members").values({ project_id: project.id, user_id: ownerId, role: "owner" }).execute();
  return project;
}

async function addMember(projectId: string, userId: string, role: "owner" | "editor" | "viewer") {
  await db.insertInto("project_members").values({ project_id: projectId, user_id: userId, role }).execute();
}

/** Duplicated from `server.test.ts` — see that file's own comment (and `apps/api/src/realtime/ticket.ts`'s header) on why ticket mint/verify logic is intentionally not shared across test files/apps. */
function mintTicket(input: { sub: string; projectId: string; role: "owner" | "editor" | "viewer" }): string {
  return jwt.sign(
    { sub: input.sub, projectId: input.projectId, role: input.role, jti: crypto.randomUUID() },
    process.env.REALTIME_TICKET_SECRET!,
    { algorithm: "HS256", expiresIn: 60 },
  );
}

function connect(projectId: string, ticket: string): { provider: HocuspocusProvider; authenticated: Promise<void> } {
  let resolveAuthenticated!: () => void;
  const authenticated = new Promise<void>((resolve) => {
    resolveAuthenticated = resolve;
  });
  const provider = trackProvider(
    new HocuspocusProvider({
      url: WS_URL,
      name: projectId,
      token: ticket,
      document: new Y.Doc(),
      onAuthenticated: () => resolveAuthenticated(),
    }),
  );
  return { provider, authenticated };
}

/** The exact shape `apps/web/src/collab/awareness.ts`'s `AwarenessState` describes — reproduced here (not imported: `apps/web` isn't a dependency of `apps/realtime`, and this is a small, stable, cheap-to-duplicate wire shape, same precedent as this repo's other cross-app "don't share, duplicate" calls) purely so this test's assertions read the same field names the real client code publishes. */
function samplePresence(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: "u-owner",
    displayName: "Owner",
    avatarUrl: "https://example.com/a.png",
    color: "hsl(120, 70%, 55%)",
    cursor: { x: 12, y: 34, containerId: "root" },
    selection: ["node-1"],
    editingField: { nodeId: "node-1", field: "limit" },
    ...overrides,
  };
}

/** Polls `awareness.getStates()` (via its own `"change"` event, not a fixed-delay sleep) until `predicate` is true, or rejects after `timeoutMs`. */
function waitForAwareness(
  awareness: NonNullable<HocuspocusProvider["awareness"]>,
  predicate: (states: Map<number, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for the expected awareness state")), timeoutMs);
    const check = () => {
      if (predicate(awareness.getStates())) {
        clearTimeout(timer);
        awareness.off("change", check);
        resolve();
      }
    };
    awareness.on("change", check);
    check(); // in case the predicate is already true (e.g. state arrived before this listener attached)
  });
}

describe("presence / Awareness (Job 021) — real two-provider convergence over the real server", () => {
  it("propagates one client's published Awareness state to a second, independently-connected client", async () => {
    const owner = await createTestUser("presence-converge-owner");
    const editor = await createTestUser("presence-converge-editor");
    const project = await createTestProject(owner.id);
    await addMember(project.id, editor.id, "editor");

    const { provider: providerA, authenticated: authA } = connect(project.id, mintTicket({ sub: owner.id, projectId: project.id, role: "owner" }));
    const { provider: providerB, authenticated: authB } = connect(project.id, mintTicket({ sub: editor.id, projectId: project.id, role: "editor" }));
    await Promise.all([authA, authB]);

    const awarenessA = providerA.awareness!;
    const awarenessB = providerB.awareness!;
    const presence = samplePresence({ userId: owner.id });
    awarenessA.setLocalState(presence);

    await waitForAwareness(awarenessB, (states) =>
      Array.from(states.values()).some((s: unknown) => (s as { userId?: string }).userId === owner.id),
    );

    const received = Array.from(awarenessB.getStates().values()).find(
      (s: unknown) => (s as { userId?: string }).userId === owner.id,
    ) as typeof presence;
    // The full shape survives the round trip through the real server
    // unmodified — including `cursor`/`selection`/`editingField`, the three
    // fields `PresenceCursors.tsx`/`RecipeNode.tsx`'s halo/field-indicator
    // rendering depend on.
    expect(received).toEqual(presence);
  });

  it("clears a disconnected peer's Awareness state from the other client, with no stranded presence — the exact failure mode PLAN.md warns hard locks suffer from", async () => {
    const owner = await createTestUser("presence-disconnect-owner");
    const editor = await createTestUser("presence-disconnect-editor");
    const project = await createTestProject(owner.id);
    await addMember(project.id, editor.id, "editor");

    const { provider: providerA, authenticated: authA } = connect(project.id, mintTicket({ sub: owner.id, projectId: project.id, role: "owner" }));
    const { provider: providerB, authenticated: authB } = connect(project.id, mintTicket({ sub: editor.id, projectId: project.id, role: "editor" }));
    await Promise.all([authA, authB]);

    const awarenessA = providerA.awareness!;
    const awarenessB = providerB.awareness!;
    // Publish a full presence footprint — cursor, selection, AND an active
    // editingField — so this test proves all three clear together, not just
    // whichever one happened to be checked.
    awarenessA.setLocalState(samplePresence({ userId: owner.id }));

    await waitForAwareness(awarenessB, (states) =>
      Array.from(states.values()).some((s: unknown) => (s as { userId?: string }).userId === owner.id),
    );
    expect(awarenessB.getStates().size).toBeGreaterThanOrEqual(2); // both clients visible to B at this point (B sees itself + A)

    // Ungraceful-enough for this test's purposes: a real WebSocket close
    // (`provider.destroy()` tears down the socket), same mechanism a closed
    // browser tab or lost connection triggers — nothing in this repo's own
    // code runs any explicit "unpublish my presence" step (confirmed by
    // reading `useLocalPresence.ts`'s own header comment); this is entirely
    // `@hocuspocus/server`'s own `Document.removeConnection` ->
    // `removeAwarenessStates` behavior being exercised for real.
    providerA.destroy();

    await waitForAwareness(
      awarenessB,
      (states) => !Array.from(states.values()).some((s: unknown) => (s as { userId?: string })?.userId === owner.id),
    );

    const remaining = Array.from(awarenessB.getStates().values());
    expect(remaining.some((s: unknown) => (s as { userId?: string }).userId === owner.id)).toBe(false);
  });
});
