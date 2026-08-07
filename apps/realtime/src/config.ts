// Job 020: env vars for the Hocuspocus server itself, plus the ones shared
// with `apps/api` (see that app's `src/realtime/config.ts` for why these
// are independently-read env vars rather than a shared config module).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

// apps/realtime/src/config.ts is the same depth below the repo root as
// apps/api/src/db.ts (both "apps/<name>/src"), so the original
// "../../../infra/.env" relative path is correct here too.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../infra/.env") });

// Keep these two dev-only fallbacks in sync with apps/api/src/realtime/config.ts's
// own copies — a mismatch here means every real ticket/webhook call fails
// signature verification in dev, which is confusing to debug since nothing
// is actually misconfigured about the *code*, just the two processes' env.
const DEV_REALTIME_TICKET_SECRET = "dev-insecure-realtime-ticket-secret-do-not-use-in-production";
const DEV_REALTIME_INTERNAL_SECRET = "dev-insecure-realtime-internal-secret-do-not-use-in-production";

export interface RealtimeConfig {
  /** HS256 secret used to verify connection tickets minted by `apps/api`. */
  ticketSecret: string;
  /** Shared secret required on the `x-internal-secret` header of the internal membership-changed webhook. */
  internalSecret: string;
  /** Port the public Hocuspocus WebSocket (+ its own trivial HTTP "Welcome" page) listens on. Matches Hocuspocus's own conventional default. */
  wsPort: number;
  /**
   * Port the *internal-only* membership-changed webhook listens on — a
   * deliberately separate `http.createServer()` from Hocuspocus's own
   * (see `internalServer.ts`'s header comment for why it can't share
   * Hocuspocus's `onRequest` hook cleanly). Never exposed publicly in a
   * real deployment — only `apps/api` should be able to reach it (a
   * reverse proxy / firewall rule in production; unrestricted in dev).
   */
  internalPort: number;
  /** How often (ms) every live connection's role is re-checked against Postgres — PLAN.md §6's "belt-and-braces... re-verify roles hourly." Configurable so tests don't wait a real hour. */
  reverifyIntervalMs: number;
  /** Passed straight through to Hocuspocus's own `debounce`/`maxDebounce` (`onStoreDocument` batching) — defaults match Hocuspocus's own built-in defaults (2s / 10s); overridable so tests don't wait multiple seconds to observe a persisted write. */
  storeDebounceMs: number;
  storeMaxDebounceMs: number;
}

const DEFAULT_WS_PORT = 1234;
const DEFAULT_INTERNAL_PORT = 1235;
const DEFAULT_REVERIFY_INTERVAL_MS = 60 * 60 * 1000;
// Hocuspocus's own defaults (see @hocuspocus/server's defaultConfiguration) — kept here as explicit, named defaults rather than omitting the fields, so config.ts is a complete picture of what governs onStoreDocument timing.
const DEFAULT_STORE_DEBOUNCE_MS = 2000;
const DEFAULT_STORE_MAX_DEBOUNCE_MS = 10_000;

export function getRealtimeConfig(): RealtimeConfig {
  return {
    ticketSecret: process.env.REALTIME_TICKET_SECRET ?? DEV_REALTIME_TICKET_SECRET,
    internalSecret: process.env.REALTIME_INTERNAL_SECRET ?? DEV_REALTIME_INTERNAL_SECRET,
    wsPort: Number(process.env.REALTIME_PORT ?? DEFAULT_WS_PORT),
    internalPort: Number(process.env.REALTIME_INTERNAL_PORT ?? DEFAULT_INTERNAL_PORT),
    reverifyIntervalMs: Number(process.env.REALTIME_REVERIFY_INTERVAL_MS ?? DEFAULT_REVERIFY_INTERVAL_MS),
    storeDebounceMs: Number(process.env.REALTIME_STORE_DEBOUNCE_MS ?? DEFAULT_STORE_DEBOUNCE_MS),
    storeMaxDebounceMs: Number(process.env.REALTIME_STORE_MAX_DEBOUNCE_MS ?? DEFAULT_STORE_MAX_DEBOUNCE_MS),
  };
}
