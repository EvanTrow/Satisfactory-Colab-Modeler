// Job 029: WCAG 2.1 contrast-ratio math, plus a literal snapshot of every
// design token from `index.css`'s `.light`/`.dark` blocks (Job 014) that
// this app actually uses as *text* color. There's no way to import a CSS
// custom property's value into TypeScript, so this is a deliberately
// hand-kept duplicate — see `contrastAudit.test.ts`'s header for how the
// two are kept from drifting apart silently.
//
// This exists because Job 014's original palette had several real,
// measured contrast failures once actually checked against WCAG's formula
// rather than eyeballed: `--text-muted` at 2.64-2.84:1 (light) and
// 3.81-4.10:1 (dark) against its own surface tokens, `--blueprint` at
// 2.84:1 against `--blueprint-soft`, `--outpost` at 3.88:1 against
// `--outpost-soft`, `--splurger` at 4.12:1 against `--splurger-soft` — all
// under WCAG AA's 4.5:1 minimum for normal-size text. `index.css`'s
// per-token comments document each fix; this module is what proves it and
// keeps proving it.

/** sRGB 0-255 channel -> linearized channel, per the WCAG relative-luminance formula. */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export type Rgb = readonly [number, number, number];

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function hexToRgb(hex: string): Rgb {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = Number.parseInt(h, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/** Alpha-composite an rgba(...) color over an opaque hex background, returning the resulting opaque RGB. */
export function compositeOver([r, g, b, a]: readonly [number, number, number, number], bgHex: string): Rgb {
  const bg = hexToRgb(bgHex);
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
}

/**
 * Parses either a `#rgb`/`#rrggbb` literal or an `rgba(r, g, b, a)` string
 * (the two color forms `index.css`'s tokens actually use) into an opaque
 * RGB, compositing translucent colors over `baseHex` first — every `-soft`
 * token in this app is a translucent overlay meant to sit on
 * `--surface-panel`, so that's the right compositing base for this app's
 * own usage, not a generic "assume white" default.
 */
export function parseColor(color: string, baseHex: string): Rgb {
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) return hexToRgb(trimmed);
  const match = /rgba?\(([^)]+)\)/.exec(trimmed);
  if (match) {
    const parts = match[1]!.split(",").map((s) => Number.parseFloat(s.trim()));
    if (parts.length === 4) return compositeOver(parts as [number, number, number, number], baseHex);
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  throw new Error(`contrastAudit: cannot parse color "${color}"`);
}

/** WCAG 2.1 contrast ratio between two colors, each resolved against `baseHex` if translucent. */
export function contrastRatio(fg: string, bg: string, baseHex: string): number {
  const l1 = relativeLuminance(parseColor(fg, baseHex));
  const l2 = relativeLuminance(parseColor(bg, baseHex));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA minimum for normal-size text (the case almost everything in this app's UI chrome is — labels, hints, timestamps, badges under 18pt/24px). */
export const WCAG_AA_NORMAL_TEXT = 4.5;
/** WCAG AA minimum for large text (>=18pt/24px regular, or >=14pt/18.66px bold) — not relied on anywhere in this audit; kept for reference. */
export const WCAG_AA_LARGE_TEXT = 3.0;

/**
 * Hand-kept snapshot of `index.css`'s token values, post Job 029's fixes.
 * Only tokens this app actually renders as *text* color somewhere are
 * listed — background/border-only tokens (`-soft`, `-border` suffixes as
 * backgrounds) don't carry WCAG's stricter text-contrast requirement
 * themselves, only as the *background half* of a text/background pair.
 */
export const LIGHT_TOKENS: Record<string, string> = {
  "surface-app": "#eae5db",
  "surface-panel": "#f5f1e8",
  "surface-card": "#f4efe4",
  "surface-sunken": "#e3ddd0",
  "text-primary": "#2d2c2c",
  "text-secondary": "#615f5f",
  "text-muted": "#646160",
  accent: "#4f46e5",
  "accent-contrast": "#ffffff",
  "accent-soft": "rgba(79, 70, 229, 0.12)",
  outpost: "#9a4508",
  "outpost-soft": "rgba(217, 119, 6, 0.14)",
  danger: "#b91c1c",
  "danger-soft": "rgba(185, 28, 28, 0.12)",
  success: "#15803d",
  mismatch: "#c2410c",
  "mismatch-soft": "rgba(194, 65, 12, 0.14)",
  splurger: "#6d28d9",
  "splurger-soft": "rgba(124, 58, 237, 0.14)",
  blueprint: "#0a6b62",
  "blueprint-soft": "rgba(13, 148, 136, 0.14)",
  "node-header": "#2f4f4f",
  "node-header-text": "#f5f5f4",
};

export const DARK_TOKENS: Record<string, string> = {
  "surface-app": "#0a0a0a",
  "surface-panel": "#141414",
  "surface-card": "#18181b",
  "surface-sunken": "#0a0a0a",
  "text-primary": "#f4f4f5",
  "text-secondary": "#a1a1aa",
  "text-muted": "#8f8f97",
  accent: "#818cf8",
  "accent-contrast": "#1e1b4b",
  "accent-soft": "rgba(129, 140, 248, 0.18)",
  outpost: "#f59e0b",
  "outpost-soft": "rgba(245, 158, 11, 0.16)",
  danger: "#f87171",
  "danger-soft": "rgba(248, 113, 113, 0.16)",
  success: "#4ade80",
  mismatch: "#fb923c",
  "mismatch-soft": "rgba(251, 146, 60, 0.18)",
  splurger: "#a78bfa",
  "splurger-soft": "rgba(167, 139, 250, 0.18)",
  blueprint: "#2dd4bf",
  "blueprint-soft": "rgba(45, 212, 191, 0.18)",
  "node-header": "#2f4f4f",
  "node-header-text": "#f5f5f4",
};

/** Every text-color/background-color pair this app's components actually render, keyed as `[fgToken, bgToken]`. Grepped from `apps/web/src` `text-[var(--X)]` + the nearest ancestor `bg-[var(--Y)]` it renders against. */
export const TEXT_ON_BACKGROUND_PAIRS: readonly (readonly [string, string])[] = [
  ["text-primary", "surface-app"],
  ["text-primary", "surface-panel"],
  ["text-primary", "surface-card"],
  ["text-primary", "surface-sunken"],
  ["text-secondary", "surface-app"],
  ["text-secondary", "surface-panel"],
  ["text-secondary", "surface-card"],
  ["text-secondary", "surface-sunken"],
  ["text-muted", "surface-app"],
  ["text-muted", "surface-panel"],
  ["text-muted", "surface-card"],
  ["text-muted", "surface-sunken"],
  ["accent-contrast", "accent"],
  ["accent", "surface-app"],
  ["accent", "surface-panel"],
  ["outpost", "outpost-soft"],
  ["outpost", "surface-panel"],
  ["danger", "danger-soft"],
  ["danger", "surface-panel"],
  ["mismatch", "surface-card"],
  ["splurger", "splurger-soft"],
  ["splurger", "surface-panel"],
  ["blueprint", "blueprint-soft"],
  ["blueprint", "surface-panel"],
  ["node-header-text", "node-header"],
];
