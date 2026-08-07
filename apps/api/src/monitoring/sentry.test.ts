// Job 029: proves the no-op-when-unconfigured contract every call site in
// this app relies on — `@sentry/node` itself is mocked so this test never
// makes a real network call or needs a real DSN, matching this job's
// explicit scope boundary (no real Sentry account/project exists).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMock = {
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
};
vi.mock("@sentry/node", () => sentryMock);

describe("monitoring/sentry", () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
  });

  it("initSentry() is a no-op when SENTRY_DSN is unset — never calls Sentry.init", async () => {
    const { initSentry, isSentryEnabled, resetSentryStateForTests } = await import("./sentry.js");
    resetSentryStateForTests();
    initSentry();
    expect(sentryMock.init).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it("captureException/captureIntegrityRepairSignal are no-ops when unconfigured", async () => {
    const { captureException, captureIntegrityRepairSignal, initSentry, resetSentryStateForTests } =
      await import("./sentry.js");
    resetSentryStateForTests();
    initSentry();
    captureException(new Error("should not be reported"));
    captureIntegrityRepairSignal({ reparentedNodeIds: ["x"] });
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });

  it("initSentry() calls Sentry.init and enables reporting once SENTRY_DSN is set", async () => {
    process.env.SENTRY_DSN = "https://fake@example.com/1";
    const { captureException, initSentry, isSentryEnabled, resetSentryStateForTests } = await import(
      "./sentry.js"
    );
    resetSentryStateForTests();
    initSentry();
    expect(sentryMock.init).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: "https://fake@example.com/1", tracesSampleRate: 0 }),
    );
    expect(isSentryEnabled()).toBe(true);

    const error = new Error("boom");
    captureException(error, { url: "/x" });
    expect(sentryMock.captureException).toHaveBeenCalledWith(error, { extra: { url: "/x" } });
  });

  it("captureIntegrityRepairSignal sends a warning-level message once configured", async () => {
    process.env.SENTRY_DSN = "https://fake@example.com/1";
    const { captureIntegrityRepairSignal, initSentry, resetSentryStateForTests } = await import("./sentry.js");
    resetSentryStateForTests();
    initSentry();
    captureIntegrityRepairSignal({ deletedDanglingEdgeIds: ["e1"] });
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(
      "Integrity reducer repaired a document",
      expect.objectContaining({ level: "warning", extra: { deletedDanglingEdgeIds: ["e1"] } }),
    );
  });
});
