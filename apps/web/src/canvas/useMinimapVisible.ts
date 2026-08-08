// Job 027: minimap show/hide, persisted the same way `theme/useTheme.ts`
// persists dark/light — `localStorage`-backed account-level preference, not
// a per-document CRDT `Settings` field (this toggle isn't a collaborative
// project setting, it's "does *this browser* want the minimap on screen").
// Deliberately NOT surfaced on `routes/UserSettingsPage.tsx`: the only way
// to change it is the show/hide button in the canvas header
// (`CanvasView.tsx`) — this hook just makes that choice outlive the tab.
import { useCallback, useState } from "react";

const STORAGE_KEY = "scm-minimap-visible";

function readStoredMinimapVisible(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "true" || raw === "false" ? raw === "true" : null;
  } catch {
    // Storage can throw in locked-down/private-browsing contexts — fall
    // back to the default rather than crashing the whole canvas over a
    // minimap toggle.
    return null;
  }
}

export interface UseMinimapVisibleResult {
  showMinimap: boolean;
  toggleMinimap: () => void;
}

export function useMinimapVisible(): UseMinimapVisibleResult {
  const [showMinimap, setShowMinimapState] = useState<boolean>(() => readStoredMinimapVisible() ?? true);

  const toggleMinimap = useCallback(() => {
    setShowMinimapState((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // See `readStoredMinimapVisible` — persistence is a nicety, not
        // required for the toggle to work for the rest of this tab's session.
      }
      return next;
    });
  }, []);

  return { showMinimap, toggleMinimap };
}
