// Job 029: same no-op-when-unconfigured coverage shape as
// `apps/api`/`apps/realtime`'s own `monitoring/sentry.test.ts` — `@sentry/
// react` is mocked so this never needs a real DSN or a real browser
// `window` (this workspace's Vitest config is node-environment-only, see
// `apps/web/vitest.config.ts`'s own header comment — mocking the whole
// package sidesteps that entirely, this test never touches the real SDK).
//
// Uses `initSentry`'s `dsnOverride` param rather than mutating
// `import.meta.env.VITE_SENTRY_DSN` — see that param's own doc comment in
// `sentry.ts` for why: Vite statically replaces `import.meta.env.VITE_X`
// references at transform time, so a runtime mutation in this test file
// has no effect on the already-transformed reference inside `sentry.ts`'s
// own module (confirmed by a first version of this test that tried exactly
// that and silently kept reading the real, unset value regardless).
import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMock = {
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  ErrorBoundary: vi.fn(),
};
vi.mock("@sentry/react", () => sentryMock);

describe("monitoring/sentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a complete no-op when no DSN is provided", async () => {
    const { captureException, captureIntegrityRepairSignal, initSentry, isSentryEnabled, resetSentryStateForTests } =
      await import("./sentry.js");
    resetSentryStateForTests();
    initSentry(undefined);
    captureException(new Error("nope"));
    captureIntegrityRepairSignal({ deletedDanglingEdgeIds: ["e1"] });
    expect(sentryMock.init).not.toHaveBeenCalled();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it("reports once a DSN is provided", async () => {
    const { captureIntegrityRepairSignal, initSentry, isSentryEnabled, resetSentryStateForTests } = await import(
      "./sentry.js"
    );
    resetSentryStateForTests();
    initSentry("https://fake@example.com/1");
    expect(sentryMock.init).toHaveBeenCalledWith(expect.objectContaining({ dsn: "https://fake@example.com/1" }));
    expect(isSentryEnabled()).toBe(true);
    captureIntegrityRepairSignal({ clampedShardNodeIds: ["n1"] });
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(
      "Integrity reducer repaired a document",
      expect.objectContaining({ level: "warning", extra: { clampedShardNodeIds: ["n1"] } }),
    );
  });
});
