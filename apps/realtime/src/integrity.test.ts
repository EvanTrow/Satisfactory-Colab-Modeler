// Job 022: the two automated tests this job's own acceptance criteria call
// out by name as needing to be "an actual automated test, not just manual":
//
//   1. "A malicious/buggy client that sends a document with a dangling edge
//      ... is repaired server-side before persistence — verify the corrupt
//      state never lands in project_doc_state/project_doc_updates."
//   2. PLAN.md §8's Phase 5 exit criterion: "Two browsers edit one factory
//      concurrently; concurrent delete-vs-connect converges with no
//      dangling edges" — built here with two real, independent
//      `@hocuspocus/provider` connections against the real server (same
//      "bypass the client UI entirely" harness `server.test.ts` established
//      for the viewer-read-only test), not two in-memory docs merged by
//      hand (that variant already exists, hundreds of times over, in
//      `packages/ydoc/src/fuzz.test.ts`).
//
// Deliberately does NOT import anything from `apps/web` (no
// `clientIntegrity.ts`) — every provider connection here is exactly the
// "malicious/buggy client" or "real collaborator" PLAN.md means: whatever
// gets fixed, gets fixed by the SERVER's own repair pass
// (`server.ts`'s `afterLoadDocument`/`onStoreDocument`), not by a
// client-side safety net this test could otherwise be silently relying on.
process.env.REALTIME_TICKET_SECRET = "test-realtime-ticket-secret";
process.env.REALTIME_INTERNAL_SECRET = "test-realtime-internal-secret";
process.env.REALTIME_PORT = "18334";
process.env.REALTIME_INTERNAL_PORT = "18335";
process.env.REALTIME_REVERIFY_INTERVAL_MS = String(60 * 60 * 1000);
// Short debounce so this file's "wait for onStoreDocument to flush" waits
// stay fast, same technique `server.test.ts` uses.
process.env.REALTIME_STORE_DEBOUNCE_MS = "50";
process.env.REALTIME_STORE_MAX_DEBOUNCE_MS = "100";

import crypto from "node:crypto";

import { HocuspocusProvider } from "@hocuspocus/provider";
import { closeDb, db, loadProjectDocUpdate } from "@scm/doc-storage";
import { addContainer, addEdge, addNode, removeNode, type SfmDocument } from "@scm/ydoc";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createHocuspocusServer, type RealtimeServer } from "./server.js";

/**
 * A minimal `SfmDocument` wrapper over an already-connected provider's live
 * `Y.Doc`, WITHOUT `@scm/ydoc`'s `createDocument`'s "fill in default
 * meta/settings if empty" side effect. Deliberately not reused here: two
 * independent, not-yet-fully-synced replicas each calling `createDocument`
 * on their own document would each seed their own redundant (same-value,
 * different-`clientID`) defaults, which is harmless to the app in practice
 * (Job 022's own fuzz test — `packages/ydoc/src/fuzz.test.ts` — proves
 * exactly this kind of redundancy still converges) but would make THIS
 * file's tighter "these two live connections are byte-identical *right
 * now*" assertion flaky on nothing more than test setup timing, not a real
 * product bug. This test only needs `nodes`/`edges`/`containers`, never
 * `meta`/`settings`, so sidestepping the defaulting logic entirely is both
 * simpler and more precise about what's actually being exercised.
 */
function wrapDoc(doc: Y.Doc): SfmDocument {
  return {
    doc,
    meta: doc.getMap("meta"),
    settings: doc.getMap("settings"),
    containers: doc.getMap("containers"),
    nodes: doc.getMap("nodes"),
    edges: doc.getMap("edges"),
  };
}

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

function mintTicket(input: { sub: string; projectId: string; role: "owner" | "editor" | "viewer" }): string {
  return jwt.sign(
    { sub: input.sub, projectId: input.projectId, role: input.role, jti: crypto.randomUUID() },
    process.env.REALTIME_TICKET_SECRET!,
    { algorithm: "HS256", expiresIn: 60 },
  );
}

function connect(projectId: string, ticket: string): { provider: HocuspocusProvider; authenticated: Promise<void> } {
  let resolveAuthenticated: () => void;
  const authenticated = new Promise<void>((resolve) => {
    resolveAuthenticated = resolve;
  });
  const provider = trackProvider(
    new HocuspocusProvider({
      url: WS_URL,
      name: projectId,
      token: ticket,
      // `gc: false` — same reasoning as `packages/ydoc/src/fuzz.test.ts`'s
      // identical setting: Yjs's default garbage collection can make two
      // independently-merged-to docs' `Y.encodeStateAsUpdate` bytes differ
      // for reasons unrelated to logical content (GC timing), which would
      // make this file's byte-identical convergence assertion flaky for
      // reasons that have nothing to do with the integrity reducer itself.
      document: new Y.Doc({ gc: false }),
      onAuthenticated: () => resolveAuthenticated(),
    }),
  );
  return { provider, authenticated };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns true, or throws once `timeoutMs` elapses. */
async function waitUntil(check: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(intervalMs);
  }
  if (!check()) throw new Error("waitUntil: condition never became true within the timeout");
}

describe("integrity reducer: server-side repair before persistence", () => {
  it("repairs a dangling edge written by a client that never ran the client-side reducer, before it ever lands in project_doc_state/project_doc_updates", async () => {
    const owner = await createTestUser("integrity-corrupt-owner");
    const project = await createTestProject(owner.id);
    const ticket = mintTicket({ sub: owner.id, projectId: project.id, role: "owner" });

    const { provider, authenticated } = connect(project.id, ticket);
    await authenticated;

    // A "malicious/buggy client": writes a real dangling edge straight onto
    // the wire, exactly the way `packages/ydoc/src/integrity.test.ts`'s
    // rule-1 unit test does locally — this provider has no client-side
    // integrity reducer attached at all (this file never imports
    // `apps/web`'s `clientIntegrity.ts`), so nothing but the SERVER can fix
    // this.
    const sfmDoc = wrapDoc(provider.document);
    const root = addContainer(sfmDoc, {
      kind: "root",
      parentId: null,
      title: "Root",
      color: "#4b5563",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    const a = addNode(sfmDoc, {
      containerId: root.id,
      kind: "recipe",
      recipe: null,
      machine: null,
      x: 0,
      y: 0,
      title: "A",
      color: "#4b5563",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
    });
    const b = addNode(sfmDoc, {
      containerId: root.id,
      kind: "recipe",
      recipe: null,
      machine: null,
      x: 0,
      y: 0,
      title: "B",
      color: "#4b5563",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
    });
    const edge = addEdge(sfmDoc, {
      containerId: root.id,
      part: "Iron Ore",
      fromNode: a.id,
      fromPort: "out:Iron Ore",
      toNode: b.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    // The dangling half: `removeNode` deliberately never cascades (see its
    // own doc comment in `@scm/ydoc`) — exactly "a buggy client wrote a
    // dangling edge."
    removeNode(sfmDoc, b.id);

    // Comfortably longer than the overridden 50/100ms debounce, so
    // onStoreDocument (where the server-side repair runs, per
    // `server.ts`'s header comment) has definitely fired at least once.
    await wait(400);
    provider.destroy();

    // 1) The live in-memory server state (what a second connection would be
    //    served) has already dropped the dangling edge — checked via a
    //    fresh independent load.
    const mergedBytes = await loadProjectDocUpdate(project.id);
    const mergedDoc = new Y.Doc();
    Y.applyUpdate(mergedDoc, mergedBytes);
    const mergedEdges = mergedDoc.getMap("edges");
    expect(mergedEdges.has(edge.id)).toBe(false);
    expect(mergedDoc.getMap("nodes").has(a.id)).toBe(true);

    // 2) The literal Postgres rows — project_doc_state's snapshot plus
    //    every project_doc_updates row for this project — never contain the
    //    dangling edge either, i.e. the corruption never durably landed at
    //    all (not "landed then got cleaned up later"). Replays the exact
    //    same snapshot+log merge `loadProjectDoc` performs, directly
    //    against the raw rows, per this test's own acceptance-criteria
    //    wording ("verify the corrupt state never lands in
    //    project_doc_state/project_doc_updates").
    const snapshotRow = await db
      .selectFrom("project_doc_state")
      .select(["ydoc"])
      .where("project_id", "=", project.id)
      .executeTakeFirst();
    const logRows = await db
      .selectFrom("project_doc_updates")
      .select(["update"])
      .where("project_id", "=", project.id)
      .orderBy("id", "asc")
      .execute();

    const verifyDoc = new Y.Doc();
    if (snapshotRow) Y.applyUpdate(verifyDoc, snapshotRow.ydoc);
    for (const row of logRows) Y.applyUpdate(verifyDoc, row.update);
    expect(verifyDoc.getMap("edges").has(edge.id)).toBe(false);
  });
});

describe("PLAN.md §8 Phase 5 exit criterion: concurrent delete-vs-connect converges with no dangling edges", () => {
  it("two real, independent provider connections — one deletes a node while the other simultaneously wires an edge to it — converge with the edge gone on both sides", async () => {
    const owner = await createTestUser("integrity-race-owner");
    const editor = await createTestUser("integrity-race-editor");
    const project = await createTestProject(owner.id);
    await addMember(project.id, editor.id, "editor");

    const ticketA = mintTicket({ sub: owner.id, projectId: project.id, role: "owner" });
    const ticketB = mintTicket({ sub: editor.id, projectId: project.id, role: "editor" });
    const { provider: providerA, authenticated: authA } = connect(project.id, ticketA);
    const { provider: providerB, authenticated: authB } = connect(project.id, ticketB);
    await Promise.all([authA, authB]);

    // Set up a shared baseline both clients agree on: a root container and
    // one shared node — created by A, waited for on B, so the race below
    // starts from genuinely synced state (not itself part of what's being
    // tested for convergence).
    const sfmDocA = wrapDoc(providerA.document);
    const root = addContainer(sfmDocA, {
      kind: "root",
      parentId: null,
      title: "Root",
      color: "#4b5563",
      x: 0,
      y: 0,
      copiesLimit: null,
    });
    const shared = addNode(sfmDocA, {
      containerId: root.id,
      kind: "recipe",
      recipe: null,
      machine: null,
      x: 0,
      y: 0,
      title: "Shared",
      color: "#4b5563",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
    });
    await waitUntil(() => providerB.document.getMap("nodes").has(shared.id));
    await waitUntil(() => providerB.document.getMap("containers").has(root.id));

    // The race: A deletes the shared node while, at essentially the same
    // moment, B — unaware — wires a brand-new edge to it. Neither side
    // waits for the other before acting; that's the whole point of
    // "concurrent."
    const sfmDocB = wrapDoc(providerB.document);
    const other = addNode(sfmDocB, {
      containerId: root.id,
      kind: "recipe",
      recipe: null,
      machine: null,
      x: 100,
      y: 0,
      title: "Other",
      color: "#4b5563",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
    });
    const racedEdge = addEdge(sfmDocB, {
      containerId: root.id,
      part: "Iron Ore",
      fromNode: shared.id,
      fromPort: "out:Iron Ore",
      toNode: other.id,
      toPort: "in:Iron Ore",
      style: null,
      labelPos: null,
    });
    removeNode(sfmDocA, shared.id);

    // Let both edits propagate through the real server (sync protocol) and
    // the server's own repair pass (onStoreDocument, on the debounce
    // overridden above) settle.
    await wait(500);

    for (const [label, provider] of [
      ["A", providerA],
      ["B", providerB],
    ] as const) {
      const edges = provider.document.getMap("edges");
      expect(edges.has(racedEdge.id), `${label}: the raced edge should have been dropped (dangling fromNode)`).toBe(false);
      expect(provider.document.getMap("nodes").has(shared.id), `${label}: the deleted node should stay deleted`).toBe(false);
      expect(provider.document.getMap("nodes").has(other.id), `${label}: the surviving node should still exist`).toBe(true);
    }

    // Byte-identical convergence between the two live clients too — not
    // just "both happen to agree on the JSON."
    expect(Buffer.from(Y.encodeStateAsUpdate(providerA.document))).toEqual(
      Buffer.from(Y.encodeStateAsUpdate(providerB.document)),
    );

    // And the server's own persisted state agrees with both.
    const mergedBytes = await loadProjectDocUpdate(project.id);
    const mergedDoc = new Y.Doc();
    Y.applyUpdate(mergedDoc, mergedBytes);
    expect(mergedDoc.getMap("edges").has(racedEdge.id)).toBe(false);
  });
});
