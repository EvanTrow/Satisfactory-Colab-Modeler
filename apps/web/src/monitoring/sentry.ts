// Job 029: browser-side error-tracking SDK wiring — same no-op-until-a-
// real-DSN-exists contract as `apps/api`/`apps/realtime`'s own
// `monitoring/sentry.ts` (see either's header comment for the full
// reasoning; no real Sentry account/project exists in this sandbox).
//
// `VITE_SENTRY_DSN` (not plain `SENTRY_DSN`) — Vite only exposes
// `import.meta.env` variables prefixed `VITE_` to client bundles by
// design (anything else is a server-side secret that must never ship in a
// browser bundle); this is Vite's own documented convention, not a
// project-specific choice.
import * as Sentry from "@sentry/react";

let enabled = false;

/**
 * `dsnOverride` exists purely for testability — Vite statically replaces
 * `import.meta.env.VITE_X` references at transform time (confirmed live:
 * mutating `import.meta.env` at test runtime has no effect on an
 * already-transformed module's own reference to it), so a test can't
 * simulate "DSN set" vs. "unset" by poking `import.meta.env` the way
 * `apps/api`/`apps/realtime`'s equivalent tests poke `process.env` (a
 * genuinely dynamic runtime lookup in Node). Passing an explicit value
 * sidesteps that entirely; every real call site (`main.tsx`) calls
 * `initSentry()` with no argument, reading the real build-time env var.
 */
export function initSentry(dsnOverride?: string): void {
  const dsn = dsnOverride ?? (import.meta.env.VITE_SENTRY_DSN as string | undefined);
  if (!dsn) {
    enabled = false;
    return;
  }
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Same call as the two Node apps' modules — error capture only, no
    // performance/tracing/session-replay integrations enabled (those are
    // real ongoing costs against a real Sentry quota, out of this job's
    // "basic error-tracking" scope).
    tracesSampleRate: 0,
    integrations: [],
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
 * See `apps/api`/`apps/realtime`'s own `captureIntegrityRepairSignal` doc
 * comment for the full "why track a non-fatal repair" reasoning — this is
 * the client-side half, called from `clientIntegrity.ts`'s ongoing
 * `afterTransaction` listener and `useProjectDocument.ts`'s repair-on-load
 * pass (see `jobs/022-integrity-reducer.md`'s Handoff notes for those two
 * call sites' own history).
 */
export function captureIntegrityRepairSignal(context: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureMessage("Integrity reducer repaired a document", {
    level: "warning",
    extra: context,
  });
}

/** `Sentry.ErrorBoundary` re-exported so call sites don't need their own `@sentry/react` import just for this. */
export const SentryErrorBoundary = Sentry.ErrorBoundary;

export function resetSentryStateForTests(): void {
  enabled = false;
}
