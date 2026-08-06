// Job 014: dark/light theme mechanism (PLAN.md §3 "Platform": "dark and
// light themes"). Deliberately app-level, not canvas-only — `App.tsx` (the
// project list / login chrome) and `CanvasView.tsx` (the canvas, which
// renders its own header with no shared chrome above it — see `App.tsx`'s
// comment on that) each mount their own `<ThemeToggle>` bound to this same
// hook, so the mechanism is consistent across both, even though only one of
// the two is ever on screen at once.
//
// Mechanism, precisely (see this job's Handoff notes for the full writeup):
//   - Persisted preference: `localStorage["scm-theme"]`, `"light"` or
//     `"dark"`. Sufficient per this job's own scope wording ("localStorage
//     is sufficient for now, doesn't need to be a DB setting yet").
//   - No stored preference yet -> falls back to the OS/browser's
//     `prefers-color-scheme` media query, matching the "system default on
//     first visit" convention most apps with a manual toggle use.
//   - Applied as a `dark` or `light` class on `<html>` (`document
//     .documentElement`) — this is what `index.css`'s
//     `@custom-variant dark (&:where(.dark, .dark *));` keys Tailwind v4's
//     `dark:` variant off of (Tailwind v4's *default* dark mode, with no
//     custom variant declared, would instead key off `prefers-color-scheme`
//     directly with no way to force an explicit choice — seeing the
//     `@theme`/`@custom-variant` docs in Tailwind v4's own reference
//     confirms the class-based approach needs this one-line opt-in; v3's
//     `darkMode: 'class'` JS-config knob has no v4 equivalent since v4 has
//     no JS config file at all here). Both classes are set explicitly
//     (never left as "absence of `dark` implies light") so component CSS
//     that keys off `.light` specifically (`index.css`'s token blocks) also
//     always has an unambiguous match.
//   - `index.html` carries a tiny inline pre-hydration script that applies
//     the same class *before* `main.tsx` even runs, so there's no
//     flash-of-wrong-theme on load — this hook's own first-render
//     `useState` initializer duplicates that same read (a second,
//     idempotent application) purely so React's state is correct from the
//     start too, not because the class itself needs setting twice.
import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "scm-theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

function readStoredTheme(): ThemeMode | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    // Storage can throw in locked-down/private-browsing contexts — fall
    // back to system preference rather than crashing the whole app over a
    // theme toggle.
    return null;
  }
}

function resolveInitialTheme(): ThemeMode {
  return readStoredTheme() ?? (systemPrefersDark() ? "dark" : "light");
}

function applyThemeClass(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
}

export interface UseThemeResult {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

export function useTheme(): UseThemeResult {
  const [theme, setThemeState] = useState<ThemeMode>(resolveInitialTheme);

  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // See `readStoredTheme` — persistence is a nicety, not required for
      // the toggle to work for the rest of this tab's session.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return { theme, setTheme, toggleTheme };
}
