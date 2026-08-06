import { describe, expect, it } from "vitest";

import { getIconUrl } from "./icons";

describe("getIconUrl", () => {
  it("resolves a known part name to a URL ending in the expected filename", () => {
    const url = getIconUrl("Iron Ore");
    expect(url).toBeTruthy();
    expect(url).toMatch(/Iron_Ore[^/]*\.png$/);
  });

  it("resolves a known machine name (including a MultiMachine variant with a period) to a URL", () => {
    const url = getIconUrl("Miner Mk.3");
    expect(url).toBeTruthy();
    expect(url).toMatch(/Miner_Mk\.3[^/]*\.png$/);
  });

  it("returns undefined for a name with no corresponding icon file", () => {
    expect(getIconUrl("Not A Real Part Or Machine")).toBeUndefined();
  });
});
