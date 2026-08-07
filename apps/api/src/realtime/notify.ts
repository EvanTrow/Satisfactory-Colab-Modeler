// Job 020 / PLAN.md §6: "when membership changes, publish an invalidation
// on a Redis channel (or an in-process bus while single-instance) and
// force-disconnect affected sockets."
//
// apps/api and apps/realtime are two separate Node processes even in this
// "single-instance" deployment (per PLAN.md's own "single container host"
// framing, they're co-deployed, not co-located in one process) — so a
// literal in-process `EventEmitter` can't span them. This module is the
// cross-process leg: a small authenticated HTTP call from apps/api (whose
// routes are the only place `project_members` ever changes) to
// apps/realtime's own internal listener (`apps/realtime/src/internalServer.ts`),
// which *does* hold the real in-process registry of live Hocuspocus
// connections and force-disconnects the affected one(s) — see that file for
// the actually-in-process half of this mechanism.
//
// Upgrade path to multi-instance (documented per the job's own "don't build
// this now" guidance): replace this `fetch` with a `PUBLISH` to a Redis
// channel (e.g. `realtime:membership-changed`) that every `apps/realtime`
// instance subscribes to — a single HTTP POST to "the" realtime service
// stops being correct once there's more than one instance, since the
// specific instance holding the affected socket might not be the one that
// receives the call. Nothing else about this function's call sites needs
// to change; only the transport underneath `notifyRealtimeMembershipChanged`
// would.
import { getRealtimeInternalSecret, getRealtimeInternalUrl } from "./config.js";

const NOTIFY_TIMEOUT_MS = 2000;

/**
 * Best-effort notification that `projectId`'s membership changed (a role
 * was updated or a member was removed). Fire-and-forget from the caller's
 * perspective — callers `.catch()` this rather than awaiting it inline in
 * the request path, since a slow/unreachable `apps/realtime` should never
 * make a membership-management REST call itself slow or fail. Missing this
 * call entirely (apps/realtime down, network partition) is not a
 * correctness gap: the hourly role re-verification sweep
 * (`apps/realtime/src/revocation.ts`) is the explicit "belt-and-braces"
 * backstop PLAN.md §6 calls for, so a dropped notification only widens the
 * revocation window from "immediate" to "at most an hour," never silently
 * forever.
 *
 * `userId` narrows the disconnect to one member (a role change/removal for
 * a specific person); omit it to reconcile every connection on the project
 * (not currently exercised by any caller, but a natural extension point —
 * e.g. a future "project visibility changed" notification).
 */
export async function notifyRealtimeMembershipChanged(projectId: string, userId?: string): Promise<void> {
  const url = `${getRealtimeInternalUrl()}/internal/membership-changed`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": getRealtimeInternalSecret() },
      body: JSON.stringify({ projectId, userId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[realtime notify] membership-changed webhook for project ${projectId} returned ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
