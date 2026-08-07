// Job 029: error-tracking SDK wiring — "ready to report errors the moment
// a human supplies a real DSN," per this job's own scope, NOT an actual
// Sentry account/project (none exists in this sandbox and none was
// created — see the root README's "Production deploy" section and this
// job's own Handoff notes for exactly what a human still has to do).
//
// Every function in this module is a deliberate no-op when `SENTRY_DSN` is
// unset — which is every existing dev/test environment today, and will
// stay true for anyone who runs this app without ever setting that one env
// var. `initSentry()` is the ONLY function that reads the env var directly;
// everything else checks the internal `enabled` flag it sets, so a caller
// never needs its own "is Sentry configured" branch.
import * as Sentry from "@sentry/node";

let enabled = false;

/** Call once, as early as possible in `index.ts` — before `buildApp()`, so a startup-time exception in app construction itself is still capturable. */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    enabled = false;
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // This app has no performance-monitoring need yet (PLAN.md's
    // Verification section is about correctness/functional tests, not
    // APM) — tracing sampling stays off so this integration is purely
    // error capture, matching this job's own scope ("a basic
    // error-tracking service", not full observability.
    tracesSampleRate: 0,
  });
  enabled = true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/** No-ops when Sentry isn't configured — every call site can call this unconditionally. */
export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(error, extra ? { extra } : undefined);
}

/**
 * PLAN.md §... / this job's scope: "capturing... ideally, the CRDT
 * integrity-reducer firing (Job 022) as a signal worth tracking (since a
 * repair firing often indicates a real bug elsewhere, even though the
 * reducer's job is to make it non-fatal)." A `warning`-level message, not
 * `captureException` — a repair firing is not itself a thrown error (the
 * whole point of Job 022's reducer is that it ISN'T fatal), but it's a
 * signal worth a human's attention, same severity class Sentry's own
 * message-level API is for.
 */
export function captureIntegrityRepairSignal(context: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureMessage("Integrity reducer repaired a document", {
    level: "warning",
    extra: context,
  });
}

/** Exposed for tests only — resets the module-level flag between test files that both import this module against a real (or absent) `SENTRY_DSN`. */
export function resetSentryStateForTests(): void {
  enabled = false;
}
