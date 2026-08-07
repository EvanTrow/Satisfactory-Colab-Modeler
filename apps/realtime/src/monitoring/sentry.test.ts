// Job 029: same coverage shape as `apps/api/src/monitoring/sentry.test.ts`
// — see that file's header comment.
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

  it("is a complete no-op when SENTRY_DSN is unset", async () => {
    const { captureException, captureIntegrityRepairSignal, initSentry, isSentryEnabled, resetSentryStateForTests } =
      await import("./sentry.js");
    resetSentryStateForTests();
    initSentry();
    captureException(new Error("nope"));
    captureIntegrityRepairSignal({ deletedDanglingEdgeIds: ["e1"] });
    expect(sentryMock.init).not.toHaveBeenCalled();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it("reports once SENTRY_DSN is set", async () => {
    process.env.SENTRY_DSN = "https://fake@example.com/1";
    const { captureIntegrityRepairSignal, initSentry, resetSentryStateForTests } = await import("./sentry.js");
    resetSentryStateForTests();
    initSentry();
    expect(sentryMock.init).toHaveBeenCalledWith(expect.objectContaining({ dsn: "https://fake@example.com/1" }));
    captureIntegrityRepairSignal({ clampedShardNodeIds: ["n1"] });
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(
      "Integrity reducer repaired a document",
      expect.objectContaining({ level: "warning", extra: { clampedShardNodeIds: ["n1"] } }),
    );
  });
});
