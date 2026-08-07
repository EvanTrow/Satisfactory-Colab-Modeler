// Job 020: fetches a fresh realtime connection ticket from
// `GET /api/realtime/ticket?projectId=…` (apps/api's routes/realtime.ts).
// Deliberately a *function* the caller invokes right before every connect
// attempt (initial connect and every reconnect) rather than a value fetched
// once and cached — tickets expire in 60 seconds (see
// `apps/api/src/realtime/ticket.ts`), so caching one across a reconnect
// would just hand the server an expired ticket. `useProjectDocument.ts`
// wires this straight into `HocuspocusProvider`'s `token` option, whose
// function form (`() => Promise<string>`) is called by the provider itself
// at exactly the right moment for this.
import { ApiError } from "../../api/projects";

interface RealtimeTicketResponse {
  ticket: string;
  expiresInSeconds: number;
  role: string;
}

export async function fetchRealtimeTicket(projectId: string): Promise<string> {
  const res = await fetch(`/api/realtime/ticket?projectId=${encodeURIComponent(projectId)}`, {
    credentials: "include",
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw new ApiError(res.status, body);
  }
  const body = (await res.json()) as RealtimeTicketResponse;
  return body.ticket;
}

/**
 * The `apps/realtime` WebSocket URL. Same-origin (`/collab`) unless
 * `VITE_REALTIME_URL` overrides it — `apps/realtime` runs on its own port
 * in dev (see `apps/web/vite.config.ts`'s `/collab` WS proxy, which forwards
 * to it exactly the way `/api`/`/auth` already forward to `apps/api`), and
 * in a real deployment sits behind the same reverse proxy as everything
 * else in this "single container host" (PLAN.md's phrasing).
 *
 * Note this doesn't literally embed the projectId in the URL path the way
 * PLAN.md §6's `wss://…/collab/<projectId>?ticket=<jwt>` sketch shows —
 * `@hocuspocus/provider` sends the document name (`name: projectId`) as
 * part of the sync protocol itself, not the connection URL, so one
 * `HocuspocusProvider` per project still connects to this same fixed URL
 * with a different `name`. See this job's Handoff notes for the full
 * reasoning.
 */
export function getRealtimeWsUrl(): string {
  const override = import.meta.env.VITE_REALTIME_URL as string | undefined;
  if (override) return override;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/collab`;
}
