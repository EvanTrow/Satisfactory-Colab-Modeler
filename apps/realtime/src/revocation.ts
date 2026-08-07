// Job 020 / PLAN.md §6: force-disconnects a live Hocuspocus connection
// whose role has changed (or been revoked entirely) since it authenticated.
// This is the *actually* in-process half of the revocation mechanism —
// `apps/api/src/realtime/notify.ts`'s header comment explains the
// cross-process leg that calls into this one via `internalServer.ts`.
//
// Two triggers call the exact same reconciliation logic:
//   1. Pushed: `internalServer.ts`'s `/internal/membership-changed` handler,
//      the moment `apps/api` changes a `project_members` row.
//   2. Pulled: an hourly sweep over every live connection
//      (`reverifyIntervalMs`, PLAN.md §6's explicit "belt-and-braces...
//      re-verify roles hourly") — the backstop for a missed/failed push
//      (apps/realtime was down, a network blip, or a membership change made
//      directly against Postgres by something other than apps/api's own
//      routes).
import { resolveRole } from "@scm/doc-storage";
import type { Connection, Hocuspocus } from "@hocuspocus/server";

import type { HocuspocusContext } from "./server.js";

/** Close code used for every revocation-triggered disconnect — distinct from a normal client-initiated close, purely informational for anyone inspecting the WS close frame. */
const REVOCATION_CLOSE_CODE = 4001;

function contextOf(connection: Connection): HocuspocusContext | undefined {
  const context = connection.context as Partial<HocuspocusContext> | undefined;
  if (!context || typeof context.userId !== "string" || typeof context.role !== "string") {
    return undefined;
  }
  return context as HocuspocusContext;
}

/**
 * Re-resolves one connection's role against Postgres and closes it if the
 * role it authenticated with no longer matches — covers both "removed
 * entirely" (`resolveRole` returns `null`) and "downgraded/changed to a
 * different still-valid role" (e.g. editor -> viewer): PLAN.md's own
 * acceptance-criteria wording is "force-disconnects that member's active
 * session," not "silently flips it to read-only in place," so every
 * mismatch — not just a revocation to `null` — results in a clean
 * disconnect. The client's own reconnect logic (a fresh ticket fetch, per
 * `apps/web`'s provider wiring) picks up the corrected role from scratch;
 * nothing here tries to mutate a connection's `readOnly`/context in place.
 */
export async function reconcileConnection(connection: Connection): Promise<boolean> {
  const context = contextOf(connection);
  if (!context) return false;

  const currentRole = await resolveRole(connection.document.name, context.userId);
  if (currentRole === context.role) return false;

  connection.close({
    code: REVOCATION_CLOSE_CODE,
    reason: currentRole === null ? "membership_revoked" : "role_changed",
  });
  return true;
}

/**
 * Reconciles every live connection on `documentName` (a projectId), or only
 * `userId`'s connection(s) on it when given. Returns how many were closed.
 */
export async function reconcileProject(
  hocuspocus: Hocuspocus,
  documentName: string,
  userId?: string,
): Promise<number> {
  const document = hocuspocus.documents.get(documentName);
  if (!document) return 0;

  let closed = 0;
  for (const connection of document.getConnections()) {
    const context = contextOf(connection);
    if (!context) continue;
    if (userId && context.userId !== userId) continue;
    if (await reconcileConnection(connection)) closed++;
  }
  return closed;
}

/** Reconciles every live connection across every currently-loaded document — the hourly sweep. */
export async function reconcileAll(hocuspocus: Hocuspocus): Promise<number> {
  let closed = 0;
  for (const documentName of hocuspocus.documents.keys()) {
    closed += await reconcileProject(hocuspocus, documentName);
  }
  return closed;
}

export interface RevocationController {
  reconcileProject(documentName: string, userId?: string): Promise<number>;
  /** Stops the hourly sweep. Call on server shutdown so tests/dev restarts don't leak a timer. */
  stop(): void;
}

/** Starts the hourly (or `reverifyIntervalMs`) re-verification sweep and returns the controller `internalServer.ts` calls into for pushed notifications. */
export function startRevocationController(hocuspocus: Hocuspocus, reverifyIntervalMs: number): RevocationController {
  const interval = setInterval(() => {
    reconcileAll(hocuspocus).catch((err: unknown) => {
      console.error("[revocation] hourly re-verification sweep failed", err);
    });
  }, reverifyIntervalMs);
  // Never keeps the process alive on its own — a graceful shutdown that's
  // otherwise idle shouldn't be held open by this timer.
  interval.unref?.();

  return {
    reconcileProject: (documentName: string, userId?: string) => reconcileProject(hocuspocus, documentName, userId),
    stop: () => clearInterval(interval),
  };
}
