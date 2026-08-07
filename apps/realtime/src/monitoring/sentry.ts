// Job 029: same module shape/contract as `apps/api/src/monitoring/sentry.ts`
// — see that file's header comment for the full reasoning (no real Sentry
// account/project exists; this is SDK wiring only, no-op until a human
// supplies a real `SENTRY_DSN`). Kept as two separate small files rather
// than a shared `packages/*` module — this is Node-runtime-process
// bootstrapping glue specific to each app's own entrypoint, not product
// logic either app needs to share.
import * as Sentry from "@sentry/node";

let enabled = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    enabled = false;
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0,
  });
  enabled = true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(error, extra ? { extra } : undefined);
}

/**
 * PLAN.md/this job's scope: the integrity reducer (Job 022) firing is a
 * signal worth tracking even though it's explicitly non-fatal by design —
 * `apps/realtime`'s `server.ts` calls this from BOTH `afterLoadDocument`
 * (a client synced in a document that was already corrupt) and
 * `onStoreDocument` (a client's own edits produced something the reducer
 * had to fix) — the server side of the "even a malicious/buggy client
 * can't persist a corrupt document" enforcement Job 022 built.
 */
export function captureIntegrityRepairSignal(context: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureMessage("Integrity reducer repaired a document", {
    level: "warning",
    extra: context,
  });
}

export function resetSentryStateForTests(): void {
  enabled = false;
}
