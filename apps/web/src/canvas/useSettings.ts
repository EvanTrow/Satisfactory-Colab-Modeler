// Job 014: a thin reactive read of the document-wide `Settings` singleton
// (`@scm/ydoc`'s `getSettings`), for the handful of places that need it at
// *render* time — the canvas background grid's dot spacing (`CanvasView.tsx`)
// and the snap-toggle checkboxes (`SettingsMenu.tsx`). Everywhere else that
// needs a settings value (`useYjsSync.ts`'s `onNodeDragStop`,
// `ConnectionEdge.tsx`'s waypoint-commit handler) reads it with a plain
// synchronous `getSettings(sfmDoc)` call at the moment of the drag-stop
// event instead — those are one-off reads at a specific instant, not
// something that needs to re-render when settings change, so they don't
// need this hook.
//
// Mirrors `useYjsSync.ts`'s own observe-then-resync pattern, scoped to just
// the `settings` map: `Settings`'s nested fields (`gridMachine`/
// `gridWaypoint`/`numberFormats`) are stored as plain JS objects rather than
// nested `Y.Map`s (see `mutations.ts`'s `updateSettings` doc comment), so a
// shallow `.observe()` — not `.observeDeep()` — is enough to catch every
// patch `updateSettings` can make (it always replaces a whole top-level key,
// never mutates inside a nested plain object in place).
import { useEffect, useState } from "react";

import { getSettings, type Settings, type SfmDocument } from "@scm/ydoc";

export function useSettings(sfmDoc: SfmDocument): Settings {
  const [settings, setSettings] = useState<Settings>(() => getSettings(sfmDoc));

  useEffect(() => {
    const sync = () => setSettings(getSettings(sfmDoc));
    sync(); // the doc may already differ from the initial render's snapshot by the time this effect attaches
    sfmDoc.settings.observe(sync);
    return () => sfmDoc.settings.unobserve(sync);
  }, [sfmDoc]);

  return settings;
}
