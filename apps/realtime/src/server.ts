// Job 020: the real Hocuspocus server — PLAN.md §5 "Real-Time Sync
// Architecture → Server" / §6 "Discord OAuth2 Flow → Tying sessions to the
// WebSocket layer". Wires:
//   - `onAuthenticate`: verifies the ticket (signature + TTL + projectId
//     match, via `ticket.ts`), then RE-CHECKS the role against Postgres
//     (`@scm/doc-storage`'s `resolveRole`) so a revocation that happened
//     *between* minting the ticket and opening the socket still applies at
//     connect time — PLAN.md §6's own wording, quoted in this repo's job
//     file. `role === "viewer"` sets genuine server-side `readOnly` (see
//     `HocuspocusContext`/the acceptance-criteria test in `server.test.ts`
//     for what "genuine" means here: Hocuspocus itself drops inbound Yjs
//     update messages on a `readOnly` connection — see
//     `@hocuspocus/server`'s `MessageReceiver.readSyncMessage`, which never
//     calls `readUpdate` for one — this repo's own code never re-derives
//     that guarantee, it just sets the flag Hocuspocus already enforces).
//   - `onLoadDocument` / `onStoreDocument`: call straight into
//     `@scm/doc-storage`'s `loadProjectDocUpdate`/`appendUpdate` — the exact
//     same functions `apps/api`'s REST doc routes call — rather than
//     reimplementing the merge/compaction algorithm. See that package's
//     `index.ts` for the full architectural reasoning behind promoting it
//     there instead of duplicating it.
import {
  Server,
  type Connection,
  type onAuthenticatePayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
} from "@hocuspocus/server";
import type { ProjectMemberRole } from "@scm/db";
import { appendUpdate, loadProjectDocUpdate, resolveRole } from "@scm/doc-storage";
import * as Y from "yjs";

import { getRealtimeConfig } from "./config.js";
import { startInternalServer } from "./internalServer.js";
import { startRevocationController } from "./revocation.js";
import { TicketError, verifyRealtimeTicket } from "./ticket.js";

/** What `onAuthenticate` attaches to every connection — read back by `onStoreDocument` (who made the edit) and `revocation.ts` (whose role to re-check). */
export interface HocuspocusContext {
  userId: string;
  role: ProjectMemberRole;
}

/**
 * Tracks, per loaded document (`documentName`, i.e. `projectId`), the state
 * vector as of the last successful `onStoreDocument` (seeded right after
 * `onLoadDocument` finishes — see `afterLoadDocument` below) — lets
 * `onStoreDocument` persist only the *incremental* diff
 * (`Y.encodeStateAsUpdate(document, lastKnownVector)`) instead of the whole
 * current state on every debounced flush, preserving PLAN.md §4's "Write =
 * append one row (no rewriting the document)" / "writes are O(change)"
 * property that Job 015/016 built and tested for the REST transport — this
 * job's WebSocket transport shouldn't regress it back to O(document) writes
 * just because Hocuspocus's own `onStoreDocument` payload only exposes the
 * live `Document` (a full `Y.Doc`), not a pre-computed diff. Cleared on
 * unload so a long-running process doesn't accumulate one entry per
 * project ever opened; a fresh reload just re-seeds it from
 * `afterLoadDocument` again.
 */
const lastStoredStateVectorByDocument = new Map<string, Uint8Array>();

/** Everything `createHocuspocusServer` starts, plus one `stop()` that tears all of it down cleanly (used by `index.ts` on shutdown and by tests). */
export interface RealtimeServer {
  server: Server<HocuspocusContext>;
  stop(): Promise<void>;
}

export async function createHocuspocusServer(): Promise<RealtimeServer> {
  const config = getRealtimeConfig();

  const server = new Server<HocuspocusContext>({
    port: config.wsPort,
    debounce: config.storeDebounceMs,
    maxDebounce: config.storeMaxDebounceMs,

    async onAuthenticate(data: onAuthenticatePayload<HocuspocusContext>) {
      const { token, documentName, connectionConfig } = data;

      let ticket;
      try {
        ticket = verifyRealtimeTicket(token, documentName);
      } catch (err) {
        throw err instanceof TicketError ? err : new TicketError(String(err));
      }

      // The re-check PLAN.md §6 calls out by name: the ticket's own `role`
      // claim is what it was true at *mint* time (up to 60s ago); a
      // revocation landing inside that window must still apply here.
      const currentRole = await resolveRole(documentName, ticket.sub);
      if (currentRole === null) {
        throw new TicketError("no longer a member of this project");
      }

      if (currentRole === "viewer") {
        // The actual server-side enforcement boundary — see this file's
        // header comment for exactly what Hocuspocus does with this flag.
        connectionConfig.readOnly = true;
      }

      // Merged into the connection's context by Hocuspocus's own hook
      // plumbing (the extension's return value becomes `contextAdditions`,
      // shallow-merged into `hookPayload.context` — see
      // `@hocuspocus/server`'s `ClientConnection.handleQueueingMessage`).
      return { userId: ticket.sub, role: currentRole } satisfies HocuspocusContext;
    },

    async onLoadDocument(data: onLoadDocumentPayload<HocuspocusContext>) {
      // Returning a `Uint8Array` here is exactly what Hocuspocus's own
      // `loadDocument` expects: it `Y.applyUpdate`s it into the empty
      // `Document` it already created for this connection (see
      // `@hocuspocus/server`'s `Hocuspocus.loadDocument`).
      return loadProjectDocUpdate(data.documentName);
    },

    afterLoadDocument(data) {
      // Seed the diff base *after* load (persisted content merged in, no
      // edits yet) rather than before — see `lastStoredStateVectorByDocument`'s
      // doc comment for why this keeps onStoreDocument's writes small.
      lastStoredStateVectorByDocument.set(data.documentName, Y.encodeStateVector(data.document));
      return Promise.resolve();
    },

    async onStoreDocument(data: onStoreDocumentPayload<HocuspocusContext>) {
      const { document, documentName, lastContext } = data;
      const priorVector = lastStoredStateVectorByDocument.get(documentName);
      const update = priorVector
        ? Y.encodeStateAsUpdate(document, priorVector)
        : Y.encodeStateAsUpdate(document);

      // Nothing changed since the last store (Hocuspocus's own debounce can
      // coalesce multiple triggers) — an empty diff is still a valid Yjs
      // update (just a couple of bytes), but there's no reason to insert a
      // no-op row for it.
      if (update.length > 0) {
        const actorUserId = (lastContext as HocuspocusContext | undefined)?.userId ?? null;
        await appendUpdate(documentName, update, actorUserId);
      }
      lastStoredStateVectorByDocument.set(documentName, Y.encodeStateVector(document));
    },

    afterUnloadDocument(data) {
      lastStoredStateVectorByDocument.delete(data.documentName);
      return Promise.resolve();
    },
  });

  await server.listen(config.wsPort);

  // Job 020 / PLAN.md §6: the revocation mechanism — see revocation.ts's
  // header comment for the push (internalServer.ts) + pull (hourly sweep)
  // split.
  const revocation = startRevocationController(server.hocuspocus, config.reverifyIntervalMs);
  const internal = startInternalServer({
    port: config.internalPort,
    secret: config.internalSecret,
    onMembershipChanged: (projectId, userId) => revocation.reconcileProject(projectId, userId),
  });

  async function stop(): Promise<void> {
    revocation.stop();
    await new Promise<void>((resolve) => internal.close(() => resolve()));
    await server.destroy();
  }

  return { server, stop };
}

export type { Connection };
