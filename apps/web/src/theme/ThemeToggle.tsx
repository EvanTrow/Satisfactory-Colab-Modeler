// Job 014: the theme toggle button — a small sun/moon icon switch, mounted
// once in `App.tsx`'s header (project list / login chrome) and once in
// `CanvasView.tsx`'s header (the canvas has no shared chrome above it), both
// bound to the same `useTheme()` hook. Deliberately a plain inline SVG
// rather than an emoji glyph (unlike `OutpostNode.tsx`'s 📦, which Job 013
// left as a placeholder this job's own Handoff notes call out as
// intentionally *not* touched) — this is a permanent piece of chrome, not a
// placeholder, and it needs to render crisply at a fixed small size in both
// themes.
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
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={className ?? baseClass}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? (
        // Moon glyph — shown while dark is active, click to go light.
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
      ) : (
        // Sun glyph — shown while light is active, click to go dark.
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
          <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4.95 2.05a1 1 0 010 1.414l-.707.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zm-2.05 4.95a1 1 0 01-1.414 0l-.707-.707a1 1 0 111.414-1.414l.707.707a1 1 0 010 1.414zM10 15a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zm-4.95-.05a1 1 0 010-1.414l.707-.707a1 1 0 111.414 1.414l-.707.707a1 1 0 01-1.414 0zM4 10a1 1 0 01-1 1H2a1 1 0 110-2h1a1 1 0 011 1zm1.05-4.95a1 1 0 011.414 0l.707.707A1 1 0 015.757 7.17l-.707-.707a1 1 0 010-1.414zM10 6a4 4 0 100 8 4 4 0 000-8z" />
        </svg>
      )}
    </button>
  );
}
