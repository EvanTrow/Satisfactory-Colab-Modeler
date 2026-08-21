// Persists `SummaryPanel.tsx`'s pinned-sidebar toggle the same way
// `canvas/useMinimapVisible.ts` persists the minimap toggle —
// `localStorage`-backed account-level preference (this browser's own
// choice, not a collaborative per-document CRDT `Settings` field), so it
// outlives the tab/reload instead of resetting to unpinned every time.
// Defaults to `false` (unlike the minimap's default-on): pinning is an
// opt-in "keep this visible while I work" choice, not something every
// project should open into by default.
import { useCallback, useState } from "react";

const STORAGE_KEY = "scm-summary-pinned";

function readStoredSummaryPinned(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "true" || raw === "false" ? raw === "true" : null;
  } catch {
    // Storage can throw in locked-down/private-browsing contexts — fall
    // back to the default rather than crashing the whole canvas over a
    // sidebar-pin preference.
    return null;
  }
}

export interface UseSummaryPinnedResult {
  pinned: boolean;
  /** Unlike `useMinimapVisible`'s `toggleMinimap`, this takes the target value directly — `SummaryPanel.tsx` already knows which way it wants to go (pin/unpin/pop-out-close-pin, etc.) at every call site, so there's no toggle-vs-set mismatch to bridge. */
  setPinned: (pinned: boolean) => void;
}

export function useSummaryPinned(): UseSummaryPinnedResult {
  const [pinned, setPinnedState] = useState<boolean>(() => readStoredSummaryPinned() ?? false);

  const setPinned = useCallback((next: boolean) => {
    setPinnedState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // See `readStoredSummaryPinned` — persistence is a nicety, not
      // required for the toggle to work for the rest of this tab's session.
    }
  }, []);

  return { pinned, setPinned };
}
