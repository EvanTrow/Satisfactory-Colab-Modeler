// Guest-mode work: the local-only sibling of `CanvasView.tsx`. Structurally
// mirrors that file's own top-level `CanvasView` — resolve "do we have a
// hydrated document yet," render the same loading/error chrome
// (`CanvasStatusScreen`) while we don't — but sources the document from
// `useLocalOnlyProjectDocument` (pure IndexedDB, no server) instead of
// `useProjectDocument`, and renders `CanvasViewReady` with `mode="guest"`.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { LocalUserIdentity } from "../collab";
import { CanvasStatusScreen, CanvasViewReady } from "./CanvasView";
import { useLocalOnlyProjectDocument } from "./persistence/useLocalOnlyProjectDocument";

interface GuestCanvasViewProps {
  guestId: string;
  projectTitle: string;
  onBack: () => void;
}

export function GuestCanvasView({ guestId, projectTitle, onBack }: GuestCanvasViewProps) {
  const { t } = useTranslation("app");
  const docState = useLocalOnlyProjectDocument(guestId);

  // A guest project has no real Discord identity to publish as Awareness
  // state — this browser is always the only "peer" — so a fixed local
  // display name stands in. Memoized so `CanvasViewReady`'s `docContext`
  // (which lists `localUser` fields among its own `useMemo` dependencies)
  // doesn't see a "changed" identity every render.
  const localUser: LocalUserIdentity = useMemo(
    () => ({ id: "guest-local", displayName: t("guestMode.localDisplayName"), avatarUrl: "" }),
    [t],
  );

  if (docState.status === "loading") {
    return (
      <CanvasStatusScreen projectTitle={projectTitle} onBack={onBack}>
        {t("canvas.loadingProject")}
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
      mode="guest"
      sfmDoc={docState.sfmDoc}
      rootContainerId={docState.rootContainerId}
      undoManager={docState.undoManager}
      awareness={docState.awareness}
      // Guest projects have no server row — `guestId` fills the `projectId`
      // slot purely because `CanvasViewReady`'s prop is required, but it's
      // never actually read in `mode="guest"` (VersionPanel/SharingPanel,
      // the two consumers, only render in `mode === "cloud"`).
      projectId={guestId}
      projectTitle={projectTitle}
      // Guest projects are always fully owned by the one person editing
      // them locally — there's no membership/role concept to check.
      role="owner"
      localUser={localUser}
      saveStatus={docState.saveStatus}
      onBack={onBack}
    />
  );
}
