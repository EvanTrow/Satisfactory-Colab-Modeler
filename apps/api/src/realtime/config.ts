// Job 020: env vars shared with `apps/realtime` (Hocuspocus) — the
// ticket-signing secret, the internal-webhook shared secret, and the URL of
// `apps/realtime`'s internal HTTP endpoint. `apps/api` mints tickets and
// calls the webhook; `apps/realtime` verifies tickets and serves the
// webhook. Both processes read the *same* env var names independently
// (see `infra/.env.example`) rather than importing a shared config module —
// unlike `@scm/doc-storage` (which genuinely needed to be a shared package,
// since the persistence algorithm it carries is substantial and would drift
// if duplicated), this is a handful of env var reads with matching
// dev-fallback strings, not logic worth a package. Keep the two dev
// fallbacks below in sync with `apps/realtime/src/config.ts`'s own copies if
// either ever changes.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../../infra/.env") });

// Dev-only fallbacks so `pnpm dev` works out of the box, same pattern as
// `auth/config.ts`'s `DEV_COOKIE_SECRET`. Production deploys should set real
// random values for both.
const DEV_REALTIME_TICKET_SECRET = "dev-insecure-realtime-ticket-secret-do-not-use-in-production";
const DEV_REALTIME_INTERNAL_SECRET = "dev-insecure-realtime-internal-secret-do-not-use-in-production";
const DEFAULT_REALTIME_INTERNAL_URL = "http://127.0.0.1:1235";

/** HS256 secret used to sign realtime connection tickets (`GET /api/realtime/ticket`). Must match `apps/realtime`'s `REALTIME_TICKET_SECRET`. */
export function getRealtimeTicketSecret(): string {
  return process.env.REALTIME_TICKET_SECRET ?? DEV_REALTIME_TICKET_SECRET;
}

/** Shared secret sent as `x-internal-secret` when calling `apps/realtime`'s membership-change webhook. Must match `apps/realtime`'s `REALTIME_INTERNAL_SECRET`. */
export function getRealtimeInternalSecret(): string {
  return process.env.REALTIME_INTERNAL_SECRET ?? DEV_REALTIME_INTERNAL_SECRET;
}

/** Base URL of `apps/realtime`'s internal HTTP listener (see that app's `internalServer.ts`) — not the public WebSocket port. */
export function getRealtimeInternalUrl(): string {
  return process.env.REALTIME_INTERNAL_URL ?? DEFAULT_REALTIME_INTERNAL_URL;
}
