import { describe, expect, it } from "vitest";

import { defaultAvatarIndex, discordAvatarUrl } from "./discordAvatar";

describe("discordAvatarUrl", () => {
  it("builds a real-avatar CDN URL with a .png extension for a normal hash", () => {
    expect(discordAvatarUrl("123456789012345678", "abcdef1234567890")).toBe(
      "https://cdn.discordapp.com/avatars/123456789012345678/abcdef1234567890.png",
    );
  });

  it("builds a .gif URL for an animated hash (the a_ prefix convention)", () => {
    expect(discordAvatarUrl("123456789012345678", "a_abcdef1234567890")).toBe(
      "https://cdn.discordapp.com/avatars/123456789012345678/a_abcdef1234567890.gif",
    );
  });

  it("falls back to the default-avatar embed URL when there is no avatar hash", () => {
    const url = discordAvatarUrl("123456789012345678", null);
    expect(url).toBe(`https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex("123456789012345678")}.png`);
    expect(url).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  });
});

describe("defaultAvatarIndex", () => {
  it("is deterministic for a given discordId", () => {
    expect(defaultAvatarIndex("123456789012345678")).toBe(defaultAvatarIndex("123456789012345678"));
  });

  it("stays within Discord's 0-5 default avatar range across a spread of ids", () => {
    const ids = ["0", "1", "123456789012345678", "999999999999999999", "42"];
    for (const id of ids) {
      const index = defaultAvatarIndex(id);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(5);
    }
  });

  it("matches the documented (snowflake >> 22) % 6 formula directly", () => {
    const id = "987654321098765432";
    const expected = Number((BigInt(id) >> 22n) % 6n);
    expect(defaultAvatarIndex(id)).toBe(expected);
  });

  it("falls back to 0 for a non-numeric id rather than throwing", () => {
    expect(defaultAvatarIndex("not-a-snowflake")).toBe(0);
  });
});
