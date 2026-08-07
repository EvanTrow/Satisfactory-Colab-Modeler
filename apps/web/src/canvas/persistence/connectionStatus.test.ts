import { describe, expect, it } from "vitest";

import { computeConnectionStatus } from "./connectionStatus";

describe("computeConnectionStatus", () => {
  it("is 'offline' whenever the browser itself reports no network, regardless of the socket's own status", () => {
    expect(computeConnectionStatus("connected", false)).toBe("offline");
    expect(computeConnectionStatus("connecting", false)).toBe("offline");
    expect(computeConnectionStatus("disconnected", false)).toBe("offline");
  });

  it("is 'connected' only when the socket itself is connected and the browser has a network path", () => {
    expect(computeConnectionStatus("connected", true)).toBe("connected");
  });

  it("is 'reconnecting' for both the first-ever connect attempt and a post-drop retry", () => {
    expect(computeConnectionStatus("connecting", true)).toBe("reconnecting");
    expect(computeConnectionStatus("disconnected", true)).toBe("reconnecting");
  });
});
