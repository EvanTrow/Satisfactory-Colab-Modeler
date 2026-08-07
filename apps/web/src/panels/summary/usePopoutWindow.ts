// Job 027: the pop-out mechanism behind `SummaryPanel.tsx`'s "pop out"
// action (PLAN.md §3's later-phase "pop-out summary windows"). Uses
// `window.open` + a React **portal** into that window's own DOM — a
// deliberate refinement of PLAN.md's own suggested approach ("window.open
// with a mounted React root is the simplest approach"): a `createPortal`
// keeps the popped-out content inside the SAME React tree as
// `SummaryPanel`, so it has automatic, live access to
// `SolverResultContext`/`useSettings()` exactly like the inline popover
// already does — no second React root, no context-bridging machinery
// needed to get live updates across the window boundary, because there
// never IS a boundary from React's own point of view: `ReactDOM.createPortal`
// only cares that its target is a valid DOM node, not which `window` global
// owns that node's document. See `SummaryPanel.tsx`'s own header for how
// this is actually used.
import { useCallback, useEffect, useRef, useState } from "react";

const POPOUT_NAME = "scm-summary-popout";
const POPOUT_FEATURES = "width=420,height=620,resizable=yes";

export interface PopoutWindowResult {
  /** The mount node inside the popout window's own document — `null` until `open()` succeeds. Pass straight to `createPortal`. */
  containerEl: HTMLElement | null;
  isOpen: boolean;
  open: (title: string) => void;
  close: () => void;
}

/**
 * Copies every `<link rel="stylesheet">`/`<style>` from the main document
 * into `target`'s own `<head>` — this app's Tailwind build output is one
 * such stylesheet, so this is what makes every `--surface-*`/`--text-*`
 * token (and every Tailwind utility class the portaled content uses)
 * resolve identically in the popped-out window instead of rendering
 * completely unstyled. A one-time copy at open time is enough: Vite's dev
 * server and the production build both emit a stable set of `<link>`/
 * `<style>` tags for the life of the page, same assumption `index.html`'s
 * own pre-hydration theme script already makes about the document's head.
 */
function copyStylesheetsInto(target: Document): void {
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    target.head.appendChild(node.cloneNode(true));
  }
}

/**
 * Opens/manages a single popout browser window and hands back a live DOM
 * node inside it to portal content into. Detecting when the user closes the
 * window via its own native close button — no reliable `onclose`-style
 * event fires on the OPENER side for that — is done by polling `.closed`,
 * the standard documented workaround; closing cleanly on THIS side (a
 * caller explicitly calling `close()`, or this hook's owner unmounting) is
 * immediate and synchronous.
 */
export function usePopoutWindow(): PopoutWindowResult {
  const [containerEl, setContainerEl] = useState<HTMLElement | null>(null);
  const windowRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const teardown = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    windowRef.current = null;
    setContainerEl(null);
  }, []);

  const close = useCallback(() => {
    // Idempotent — `Window.close()` on an already-closed window is a no-op,
    // and `teardown()` is safe to call even if the poll below already ran.
    windowRef.current?.close();
    teardown();
  }, [teardown]);

  const open = useCallback(
    (title: string) => {
      if (windowRef.current && !windowRef.current.closed) {
        windowRef.current.focus(); // already open — bring it forward instead of opening a second one
        return;
      }
      const win = window.open("", POPOUT_NAME, POPOUT_FEATURES);
      if (!win) return; // popup blocked — nothing more this hook can do; the caller's own inline UI stays as the fallback
      win.document.title = title;
      copyStylesheetsInto(win.document);
      const mount = win.document.createElement("div");
      win.document.body.appendChild(mount);
      windowRef.current = win;
      setContainerEl(mount);

      pollRef.current = setInterval(() => {
        if (win.closed) teardown();
      }, 500);
    },
    [teardown],
  );

  // Close cleanly if the component that owns this hook unmounts (e.g. the
  // whole canvas view is torn down) — otherwise the popout window would sit
  // there forever rendering a portal target for a React tree that no
  // longer exists, frozen on whatever it last showed. This is the "closes
  // cleanly ... when either window closes" half of this job's acceptance
  // criteria that the user-closes-it-directly path (the poll above) doesn't
  // cover on its own.
  useEffect(() => {
    return () => {
      windowRef.current?.close();
    };
  }, []);

  return { containerEl, isOpen: containerEl !== null, open, close };
}
