// Per-canvas viewport (pan/zoom) memory — `localStorage`-backed, same
// pattern as `useMinimapVisible.ts`/`theme/useTheme.ts` (a per-browser
// preference, not a collaborative `Settings` field: two peers looking at the
// same project are very reasonably scrolled to two different spots). Keyed
// by container id within a project-scoped map so the root canvas and every
// outpost each remember their own last position, and switching between them
// (`CanvasView.tsx`'s `navigateToContainer`) can restore exactly where the
// user left off in either direction.
import { useCallback, useMemo, useRef } from "react";

export interface StoredViewport {
  x: number;
  y: number;
  zoom: number;
}

function storageKey(scopeId: string): string {
  return `scm-canvas-viewport:${scopeId}`;
}

function readStoredViewports(scopeId: string): Record<string, StoredViewport> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(scopeId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, StoredViewport>;
  } catch {
    // Storage can throw in locked-down/private-browsing contexts, and a
    // corrupt/foreign value can fail to parse — either way, fall back to
    // "nothing saved yet" rather than crashing the canvas over this.
    return {};
  }
}

export interface UseCanvasViewportsResult {
  /** The last-saved viewport for `containerId`, or `null` if none was ever recorded. */
  getStoredViewport: (containerId: string) => StoredViewport | null;
  /** Records `viewport` as the current position for `containerId`, persisted immediately. */
  saveViewport: (containerId: string, viewport: StoredViewport) => void;
}

/**
 * `scopeId` namespaces the whole per-container map — the project's real id
 * where there is one, falling back to `rootContainerId` in guest mode (no
 * `projectId` at all, but still one stable id per local document) — so two
 * different projects' containers, which don't otherwise share an id space,
 * can never collide in `localStorage`.
 */
export function useCanvasViewports(scopeId: string): UseCanvasViewportsResult {
  const cacheRef = useRef<{ scopeId: string; data: Record<string, StoredViewport> }>({
    scopeId,
    data: readStoredViewports(scopeId),
  });
  if (cacheRef.current.scopeId !== scopeId) {
    cacheRef.current = { scopeId, data: readStoredViewports(scopeId) };
  }

  const getStoredViewport = useCallback(
    (containerId: string): StoredViewport | null => cacheRef.current.data[containerId] ?? null,
    [],
  );

  const saveViewport = useCallback((containerId: string, viewport: StoredViewport) => {
    cacheRef.current.data = { ...cacheRef.current.data, [containerId]: viewport };
    try {
      window.localStorage.setItem(storageKey(cacheRef.current.scopeId), JSON.stringify(cacheRef.current.data));
    } catch {
      // See `readStoredViewports` — persistence is a nicety here, not
      // required for navigation within the current tab to keep working.
    }
  }, []);

  // Memoized so consumers (`CanvasFlow`'s navigation-restore effect) get a
  // referentially stable object across unrelated re-renders — both
  // callbacks above already have empty dep arrays, so this only ever
  // produces a new object once, on mount. Without this, an effect keyed on
  // this hook's return value would re-run on every render, not just when
  // something it actually cares about changes.
  return useMemo(() => ({ getStoredViewport, saveViewport }), [getStoredViewport, saveViewport]);
}
