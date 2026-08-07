// Job 029: a small, reusable focus trap for this app's four floating
// panels that behave like modals from a keyboard user's perspective —
// `RecipeChooser.tsx` (a true modal, backdrop blocks all canvas
// interaction), and `SettingsMenu.tsx`/`SharingPanel.tsx`/
// `VersionPanel.tsx` (toolbar dropdowns that are functionally the same
// thing: a floating panel over a full-screen invisible backdrop that
// closes on outside click). None of the four had any of this before this
// job — Tab could walk focus straight out into the canvas/toolbar behind
// the open panel, with no way to know (visually or via a screen reader)
// that a panel was even open, and no keyboard-only way to get back out
// short of Escape (which only `RecipeChooser` had, via a separate
// window-level listener Job 009 added — left in place, this hook's own
// Escape handling is additive, not a replacement).
//
// Deliberately framework-minimal: no dependency added (no
// `focus-trap-react`/`react-focus-lock`) — the actual trap logic is ~30
// lines and every one of this app's four use sites already fits its
// shape exactly (a conditionally-rendered panel `<div>`, closed via a
// single `onClose` callback).
import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Every focusable descendant of `container`, in DOM/tab order. Filters out
 * elements React Flow/Tailwind may have positioned off-screen or
 * `display: none`'d without an explicit `disabled` attribute — `offsetParent
 * === null` is the cheap, standard test for "not actually visible/tabbable"
 * (it's also `null` for `position: fixed` elements, hence the
 * `getClientRects().length` fallback for this app's own `fixed inset-0`
 * backdrop-adjacent panels).
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

export interface UseFocusTrapOptions {
  /** Called on Escape, and expected to unmount/hide the trapped panel. */
  onClose: () => void;
  /** Focus this element on open instead of the first focusable descendant — e.g. a search input that should be pre-focused even though a "New Outpost" button appears earlier in the DOM. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Traps Tab/Shift+Tab focus cycling inside `containerRef`'s subtree while
 * `active` is true, moves initial focus in on activation, restores focus to
 * whatever had it before (typically the toolbar button that opened the
 * panel) on deactivation/unmount, and calls `onClose` on Escape. Every
 * effect in this hook is a no-op when `active` is false, so call sites that
 * always render the container (`RecipeChooser` — mounted only while open,
 * so `active` is always `true` there) and ones that conditionally render it
 * internally (`SettingsMenu`/`SharingPanel`/`VersionPanel` — mounted
 * unconditionally, `active` mirrors their own `open` state) both work with
 * the same hook.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  { onClose, initialFocusRef }: UseFocusTrapOptions,
) {
  // Read fresh on every keydown without re-subscribing the listener —
  // avoids re-running the whole open/close effect below on every render
  // just because a caller passed a fresh onClose closure.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const toFocus = initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container;
    // `container` itself (the fallback when a panel has zero focusable
    // descendants — shouldn't happen in practice, but fail safe rather than
    // silently leaving focus wherever it was) needs `tabIndex` to be
    // focusable at all; the four real call sites always have at least a
    // close/backdrop-adjacent control, so this branch is defensive only.
    if (toFocus === container && !container.hasAttribute("tabindex")) {
      container.setAttribute("tabindex", "-1");
    }
    toFocus.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Don't let Escape also bubble to some ancestor listener (canvas
        // keybinds, etc.) — this panel is the thing that should close.
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      // Re-derived (rather than closing over the outer `container` const)
      // so TypeScript's null-narrowing holds inside this nested function —
      // control-flow narrowing of an outer binding isn't preserved across
      // a function-declaration boundary, even for a `const`.
      const el = containerRef.current;
      if (!el) return;

      const focusable = getFocusableElements(el);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !el.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !el.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    container.addEventListener("keydown", handleKeyDown);
    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      // Return focus to whatever opened this panel — without this, closing
      // a panel (Escape, a selection, the backdrop) drops keyboard focus to
      // `<body>`, forcing a keyboard user to Tab all the way back in from
      // the top of the page to keep working.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
    // `onClose` is deliberately not a dependency — it's read via
    // `onCloseRef` above precisely so a fresh `onClose` closure on every
    // render doesn't re-run this whole open/focus/listener-attach effect.
    // `initialFocusRef` is a ref (stable identity by contract) and isn't
    // itself read reactively here (only `.current` is, at effect-run time).
  }, [active, containerRef]);
}
