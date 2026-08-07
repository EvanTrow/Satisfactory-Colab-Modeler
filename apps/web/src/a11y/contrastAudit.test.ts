// Job 029: regression test for the light/dark palette's text contrast —
// see `contrastAudit.ts`'s header for why this exists (Job 014's original
// palette had several real WCAG AA failures once actually measured). This
// is a *snapshot* test in the sense that `LIGHT_TOKENS`/`DARK_TOKENS` are a
// hand-kept duplicate of `index.css`'s real values, not a live read of the
// stylesheet (no CSS-custom-property-to-TypeScript bridge exists in this
// stack) — if a future job changes a token in `index.css` without updating
// this file too, this test keeps passing against the *stale* duplicate and
// silently stops proving anything about the real app. There is no
// automated guard against that drift; it relies on whoever touches a color
// token remembering to update both. Flagged in jobs/029's Handoff notes.
import { describe, expect, it } from "vitest";

import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  TEXT_ON_BACKGROUND_PAIRS,
  WCAG_AA_NORMAL_TEXT,
  contrastRatio,
  hexToRgb,
  relativeLuminance,
} from "./contrastAudit";

describe("contrast math", () => {
  it("computes known reference ratios (WCAG spec examples)", () => {
    // Pure black on pure white is the maximum possible ratio, 21:1.
    expect(contrastRatio("#000000", "#ffffff", "#ffffff")).toBeCloseTo(21, 1);
    // Identical colors have no contrast at all.
    expect(contrastRatio("#4f46e5", "#4f46e5", "#4f46e5")).toBeCloseTo(1, 5);
  });

  it("hexToRgb expands 3-digit shorthand the same as 6-digit", () => {
    expect(hexToRgb("#fff")).toEqual(hexToRgb("#ffffff"));
    expect(hexToRgb("#000")).toEqual(hexToRgb("#000000"));
  });

  it("relativeLuminance(white) > relativeLuminance(black)", () => {
    expect(relativeLuminance(hexToRgb("#ffffff"))).toBeGreaterThan(relativeLuminance(hexToRgb("#000000")));
  });

  it("compositing a translucent color over its base darkens/lightens predictably", () => {
    // A fully-transparent (alpha=0) fg should resolve to exactly the base color.
    const ratio = contrastRatio("rgba(0,0,0,0)", "#eae5db", "#eae5db");
    expect(ratio).toBeCloseTo(1, 5);
  });
});

describe("index.css token palette — WCAG AA text contrast", () => {
  it.each(TEXT_ON_BACKGROUND_PAIRS)("light: %s on %s clears 4.5:1", (fgKey, bgKey) => {
    const fg = LIGHT_TOKENS[fgKey];
    const bg = LIGHT_TOKENS[bgKey];
    expect(fg, `missing LIGHT_TOKENS["${fgKey}"]`).toBeDefined();
    expect(bg, `missing LIGHT_TOKENS["${bgKey}"]`).toBeDefined();
    // Translucent backgrounds (the "-soft" tokens) are meant to sit on
    // surface-panel in this app — see `parseColor`'s doc comment.
    const ratio = contrastRatio(fg!, bg!, LIGHT_TOKENS["surface-panel"]!);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  it.each(TEXT_ON_BACKGROUND_PAIRS)("dark: %s on %s clears 4.5:1", (fgKey, bgKey) => {
    const fg = DARK_TOKENS[fgKey];
    const bg = DARK_TOKENS[bgKey];
    expect(fg, `missing DARK_TOKENS["${fgKey}"]`).toBeDefined();
    expect(bg, `missing DARK_TOKENS["${bgKey}"]`).toBeDefined();
    const ratio = contrastRatio(fg!, bg!, DARK_TOKENS["surface-panel"]!);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });
});
