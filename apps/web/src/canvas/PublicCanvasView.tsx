// Public-link work: the anonymous-viewer sibling of `CanvasView.tsx`/
// `GuestCanvasView.tsx` — same "resolve 'do we have a hydrated document
// yet,' render the same loading/error chrome while we don't" shape, sourced
// from `usePublicProjectDocument` (a real server project, live-synced, but
// with no session at all) instead of `useProjectDocument`/
// `useLocalOnlyProjectDocument`. Renders `CanvasViewReady` with
// `mode="public"` — see that file's own `mode` doc comment for exactly what
// that suppresses (owner-only `VersionPanel`/`SharingPanel`, neither of
// which an anonymous visitor could call anyway) versus what it keeps
// (live presence, so a public viewer can see who else is looking).
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { LocalUserIdentity } from "../collab";
import { CanvasStatusScreen, CanvasViewReady } from "./CanvasView";
import { usePublicProjectDocument } from "./persistence/usePublicProjectDocument";

export interface PublicCanvasViewProps {
  shortId: string;
  onBack: () => void;
}

/** sessionStorage key for this tab's own anonymous presence identity — see the `localUser` memo below for why this needs to survive a reload within the same tab but never needs to persist beyond it. */
const GUEST_PRESENCE_ID_KEY = "scm_public_viewer_presence_id";

function readOrCreateGuestPresenceId(): string {
  try {
    const existing = window.sessionStorage.getItem(GUEST_PRESENCE_ID_KEY);
    if (existing) return existing;
    const created = `guest-${crypto.randomUUID()}`;
    window.sessionStorage.setItem(GUEST_PRESENCE_ID_KEY, created);
    return created;
  } catch {
    // Storage can throw in locked-down/private-browsing contexts — a
    // per-mount id is still safe, it just won't survive a reload of this
    // same tab (the presence color/identity would simply look "new").
    return `guest-${crypto.randomUUID()}`;
  }
}

export function PublicCanvasView({ shortId, onBack }: PublicCanvasViewProps) {
  const { t } = useTranslation("app");
  const docState = usePublicProjectDocument(shortId);

  // A public visitor has no real identity to publish as Awareness state —
  // "Guest" stands in, same as `GuestCanvasView.tsx`'s local-only guest
  // identity, except this one really is shared with other concurrent
  // viewers (a real live `HocuspocusProvider` connection), so it gets a
  // per-tab random id (not a fixed constant) so two simultaneous public
  // viewers get distinct presence colors/cursors instead of colliding on
  // the same one. `avatarUrl: ""` deliberately fails to load —
  // `collab/Avatar.tsx` falls back to an initial-letter badge on that.
  const localUser: LocalUserIdentity = useMemo(
    () => ({ id: readOrCreateGuestPresenceId(), displayName: t("publicView.guestDisplayName"), avatarUrl: "" }),
    [t],
  );

  const projectTitle = docState.status === "ready" ? docState.projectTitle : t("publicView.title");

  if (docState.status === "loading") {
    return (
      <CanvasStatusScreen projectTitle={projectTitle} onBack={onBack}>
        {t("canvas.loadingProject")}
      </CanvasStatusScreen>
    );
  }

  if (docState.status === "not_shared") {
    return (
      <CanvasStatusScreen projectTitle={projectTitle} onBack={onBack}>
        <p className="text-[var(--danger)]">{t("publicView.notShared")}</p>
      </CanvasStatusScreen>
    );
  }

  if (docState.status === "error") {
    return (
      <CanvasStatusScreen projectTitle={projectTitle} onBack={onBack}>
        <p className="mb-3 text-[var(--danger)]">
          {t("canvas.loadProjectError", { message: docState.message })}
        </p>
        <button
          type="button"
          onClick={docState.retry}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
        >
          {t("canvas.retry")}
        </button>
      </CanvasStatusScreen>
    );
  }

  return (
    <CanvasViewReady
      mode="public"
      sfmDoc={docState.sfmDoc}
      rootContainerId={docState.rootContainerId}
      undoManager={docState.undoManager}
      awareness={docState.awareness}
      // Never actually read in `mode="public"` (`VersionPanel`/`SharingPanel`
      // don't render here) — same "required prop, unused in this mode"
      // reasoning `GuestCanvasView.tsx` already documents for its own
      // `projectId`.
      projectId={shortId}
      projectTitle={docState.projectTitle}
      role="viewer"
      localUser={localUser}
      saveStatus="offline"
      connectionStatus={docState.connectionStatus}
      onBack={onBack}
    />
  );
}
