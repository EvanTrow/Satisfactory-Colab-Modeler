import { describe, expect, it } from "vitest";

import { parseWaypointKey, waypointKey } from "./waypointKey";

describe("waypointKey / parseWaypointKey", () => {
  it("round-trips an edge id and index", () => {
    const key = waypointKey("edge-1", 2);
    expect(parseWaypointKey(key)).toEqual({ edgeId: "edge-1", index: 2 });
  });

  it("round-trips index 0", () => {
    expect(parseWaypointKey(waypointKey("edge-1", 0))).toEqual({ edgeId: "edge-1", index: 0 });
  });

  it("handles a UUID-shaped edge id", () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(parseWaypointKey(waypointKey(id, 7))).toEqual({ edgeId: id, index: 7 });
  });

  it("rejects a malformed key (no separator, non-numeric index, empty edge id)", () => {
    expect(parseWaypointKey("edge-1")).toBeNull();
    expect(parseWaypointKey("edge-1::abc")).toBeNull();
    expect(parseWaypointKey("::3")).toBeNull();
    expect(parseWaypointKey("")).toBeNull();
  });

  it("produces distinct keys for different edges/indices (Set-safe identity)", () => {
    const keys = new Set([waypointKey("e1", 0), waypointKey("e1", 1), waypointKey("e2", 0)]);
    expect(keys.size).toBe(3);
  });
});
