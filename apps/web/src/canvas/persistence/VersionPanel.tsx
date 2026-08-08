// Job 016: the "functional minimum" version list + restore UI the job file
// calls for — "a basic restore flow: list a project's versions (timestamp,
// label, kind), and restoring one creates a new `kind: 'pre_restore'`
// snapshot of current state first... then applies the selected version's
// `ydoc` bytes as the new current state." Deliberately narrow per the job
// file's own scope note ("a functional restore is in scope, a polished
// history browser with diffing is not") — no diffing, no rich version
// management beyond a label field, styled as a `SettingsMenu.tsx`-style
// dropdown rather than a full modal.
import { History, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { useFocusTrap } from "../../a11y";
import type { ProjectRole } from "../../api/projects";
import { ConfirmDialog, useConfirmDialog } from "../../ui";
import { deleteProjectVersion, listProjectVersions, restoreProjectVersion, saveProjectVersion, type ProjectVersionInfo } from "./docApi";

export interface VersionPanelProps {
  projectId: string;
  role: ProjectRole;
  /** Called after a successful restore, once the server has applied it — the caller (`CanvasView.tsx`) is responsible for making the live canvas reflect the new state (`useProjectDocument.ts`'s `reloadAfterRestore`), since this component only talks to the REST API. */
  onRestored: () => void;
}

type ListState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "loaded"; versions: ProjectVersionInfo[] };

const KIND_LABEL: Record<ProjectVersionInfo["kind"], string> = {
  auto: "Auto",
  manual: "Manual",
  import: "Import",
  pre_restore: "Pre-restore",
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function VersionPanel({ projectId, role, onRestored }: VersionPanelProps) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ListState>({ status: "idle" });
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The version pending restore confirmation — shown as an inline prompt
  // (rather than window.confirm) so the pre-restore-backup checkbox below
  // can be offered alongside the yes/no decision.
  const [restoreTarget, setRestoreTarget] = useState<ProjectVersionInfo | null>(null);
  const [createBackupOnRestore, setCreateBackupOnRestore] = useState(true);

  const canEdit = role === "owner" || role === "editor";

  // Job 029: focus trap while the panel is open — see
  // `a11y/useFocusTrap.ts`'s header comment; same shape as
  // `SettingsMenu`/`SharingPanel`.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open, { onClose: () => setOpen(false) });
  const { requestConfirm, dialogProps: confirmDialogProps } = useConfirmDialog();

  async function refresh() {
    setList({ status: "loading" });
    try {
      const versions = await listProjectVersions(projectId);
      setList({ status: "loaded", versions });
    } catch (err) {
      setList({ status: "error", message: err instanceof Error ? err.message : "Failed to load versions" });
    }
  }

  function toggleOpen() {
    setOpen((wasOpen) => {
      const willOpen = !wasOpen;
      setRestoreTarget(null);
      if (willOpen) {
        setActionError(null);
        void refresh();
      }
      return willOpen;
    });
  }

  async function handleSave() {
    setSaving(true);
    setActionError(null);
    try {
      // Job 016 follow-up: "if no label is added, make the label the date
      // and time" — a manual save with a blank label falls back to a
      // human-readable timestamp instead of staying `null`/"(unlabeled)".
      await saveProjectVersion(projectId, label.trim() || new Date().toLocaleString());
      setLabel("");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save a version");
    } finally {
      setSaving(false);
    }
  }

  function beginRestore(version: ProjectVersionInfo) {
    setActionError(null);
    setCreateBackupOnRestore(true);
    setRestoreTarget(version);
  }

  function cancelRestore() {
    setRestoreTarget(null);
  }

  async function confirmRestore() {
    const version = restoreTarget;
    if (!version) {
      return;
    }
    setRestoringId(version.id);
    setActionError(null);
    try {
      await restoreProjectVersion(projectId, version.id, createBackupOnRestore);
      setRestoreTarget(null);
      onRestored();
      await refresh();
      setOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to restore this version");
    } finally {
      setRestoringId(null);
    }
  }

  async function handleDelete(version: ProjectVersionInfo) {
    const when = formatTimestamp(version.createdAt);
    const what = version.label ?? `${KIND_LABEL[version.kind]} version`;
    const confirmed = await requestConfirm({
      message: `Delete "${what}" from ${when}? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    setDeletingId(version.id);
    setActionError(null);
    try {
      await deleteProjectVersion(projectId, version.id);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete this version");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        title="Version history"
        aria-label="Version history"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="nodrag inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
      >
        <History className="h-3.5 w-3.5" aria-hidden />
        Versions
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Version history"
            className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-2 shadow-[var(--shadow-modal)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p className="mb-1 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Version history</p>

            {canEdit && (
              <div className="mb-2 flex gap-1 px-1">
                <input
                  type="text"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Label (optional)"
                  className="min-w-0 flex-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="shrink-0 rounded-md bg-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save version"}
                </button>
              </div>
            )}

            {actionError && (
              <p className="mb-2 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-2 py-1 text-xs text-[var(--danger)]">
                {actionError}
              </p>
            )}

            {restoreTarget && (
              <div className="mb-2 rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] p-2 text-xs text-[var(--text-secondary)]">
                <p className="text-[var(--text-primary)]">
                  Restore "{restoreTarget.label ?? `${KIND_LABEL[restoreTarget.kind]} version`}" from {formatTimestamp(restoreTarget.createdAt)}?
                </p>
                <label className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={createBackupOnRestore}
                    onChange={(event) => setCreateBackupOnRestore(event.target.checked)}
                  />
                  Save current state as a new version first
                </label>
                <div className="mt-2 flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={cancelRestore}
                    disabled={restoringId !== null}
                    className="rounded-md border border-[var(--border-default)] px-2 py-1 text-[11px] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmRestore()}
                    disabled={restoringId !== null}
                    className="rounded-md bg-[var(--accent)] px-2 py-1 text-[11px] font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                  >
                    {restoringId === restoreTarget.id ? "Restoring…" : "Restore"}
                  </button>
                </div>
              </div>
            )}

            <div className="max-h-72 overflow-y-auto">
              {list.status === "loading" && <p className="px-1 py-2 text-xs text-[var(--text-muted)]">Loading…</p>}
              {list.status === "error" && <p className="px-1 py-2 text-xs text-[var(--danger)]">{list.message}</p>}
              {list.status === "loaded" && list.versions.length === 0 && (
                <p className="px-1 py-2 text-xs text-[var(--text-muted)]">No versions saved yet.</p>
              )}
              {list.status === "loaded" &&
                list.versions.map((version) => (
                  <div
                    key={version.id}
                    className="flex items-center justify-between gap-2 rounded-md px-1 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[var(--text-primary)]">{version.label ?? "(unlabeled)"}</div>
                      <div className="text-[10px] text-[var(--text-muted)]">
                        {KIND_LABEL[version.kind]} · {formatTimestamp(version.createdAt)}
                      </div>
                    </div>
                    {canEdit && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => beginRestore(version)}
                          disabled={restoringId !== null || deletingId !== null}
                          className="rounded-md border border-[var(--border-default)] px-2 py-1 text-[11px] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(version)}
                          disabled={restoringId !== null || deletingId !== null}
                          title="Delete version"
                          aria-label="Delete version"
                          className="rounded-md border border-[var(--border-default)] px-1.5 py-1 text-[11px] text-[var(--text-muted)] hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:opacity-50"
                        >
                          {deletingId === version.id ? "…" : (
                            <Trash2 className="h-3 w-3" aria-hidden />
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </div>
        </>
      )}
      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
