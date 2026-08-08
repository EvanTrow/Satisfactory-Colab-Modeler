// Job 014: the theme toggle button — a small sun/moon icon switch, mounted
// once in `App.tsx`'s header (project list / login chrome) and once in
// `CanvasView.tsx`'s header (the canvas has no shared chrome above it), both
// bound to the same `useTheme()` hook.
import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ThemeMode } from "./useTheme";

export interface ThemeToggleProps {
  theme: ThemeMode;
  onToggle: () => void;
  /** `RecipeChooser.tsx`/`NodeContextMenu.tsx`-style compact icon button by default; pass `className` to override sizing/placement from a caller's own header layout. */
  className?: string;
}

const baseClass =
  "nodrag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]";

export function ThemeToggle({ theme, onToggle, className }: ThemeToggleProps) {
  // Job 028: "Switch to light/dark theme" has no analogue in the original
  // tool's string table (`DARK_MODE`/`LIGHT_MODE` there are just the toggle
  // *labels*, "Dark Mode"/"Light Mode" — this is a hover/aria description of
  // the *action*, a genuinely different string) — new `app` namespace key.
  const { t } = useTranslation("app");
  const isDark = theme === "dark";
  const label = t(isDark ? "theme.switchToLight" : "theme.switchToDark");
  return (
    <button
      type="button"
      onClick={onToggle}
      className={className ?? baseClass}
      title={label}
      aria-label={label}
    >
      {isDark ? (
        // Moon glyph — shown while dark is active, click to go light.
        <Moon className="h-4 w-4" aria-hidden />
      ) : (
        // Sun glyph — shown while light is active, click to go dark.
        <Sun className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}
