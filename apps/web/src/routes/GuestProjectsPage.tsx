// Guest-mode work: the local-storage sibling of `ProjectsPage.tsx`. Same
// create/rename/duplicate/delete affordances and dialog patterns, but every
// guest project is always fully owned by the one person editing it locally
// (no role/membership concept — `../guest/localProjects.ts` has no server
// to ask), so this intentionally skips `ProjectsPage.tsx`'s
// `canEdit`/`canDelete` role gating rather than threading a fake role
// through just to reuse it. Kept as its own component (not a shared
// generic with `ProjectsPage.tsx`) since the two backing stores — REST vs.
// local storage — diverge in real ways that don't warrant forcing one
// abstraction over both.
import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { useFocusTrap } from "../a11y/useFocusTrap";
import {
  createProject,
  deleteProject,
  duplicateProject,
  listProjects,
  renameProject,
  type GuestProjectSummary,
} from "../guest/localProjects";
import { ConfirmDialog, useConfirmDialog } from "../ui";

interface GuestProjectsPageProps {
  onOpenProject: (project: GuestProjectSummary) => void;
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

export function GuestProjectsPage({ onOpenProject }: GuestProjectsPageProps) {
  const { t, i18n } = useTranslation("app");
  const [projects, setProjects] = useState<GuestProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const createDialogRef = useRef<HTMLDivElement>(null);
  const newProjectInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(createDialogRef, showCreateDialog, {
    onClose: () => setShowCreateDialog(false),
    initialFocusRef: newProjectInputRef,
  });
  const { requestConfirm, dialogProps: confirmDialogProps } = useConfirmDialog();

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((result) => {
        if (cancelled) return;
        setProjects(result);
        setLoadState({ status: "ready" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadState({ status: "error", message: describeError(err, t) });
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  function openCreateDialog() {
    setActionError(null);
    setNewProjectTitle("");
    setShowCreateDialog(true);
  }

  function closeCreateDialog() {
    setShowCreateDialog(false);
    setNewProjectTitle("");
  }

  async function handleCreate() {
    setActionError(null);
    setCreating(true);
    try {
      const project = await createProject(newProjectTitle.trim() || undefined);
      setProjects((prev) => [project, ...prev]);
      closeCreateDialog();
    } catch (err) {
      setActionError(describeError(err, t));
    } finally {
      setCreating(false);
    }
  }

  function startRename(project: GuestProjectSummary) {
    setActionError(null);
    setRenamingId(project.id);
    setRenameDraft(project.title);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft("");
  }

  async function submitRename(project: GuestProjectSummary) {
    const title = renameDraft.trim();
    if (!title || title === project.title) {
      cancelRename();
      return;
    }
    setActionError(null);
    setBusyId(project.id);
    try {
      const updated = await renameProject(project.id, title);
      setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)));
      cancelRename();
    } catch (err) {
      setActionError(describeError(err, t));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDuplicate(project: GuestProjectSummary) {
    setActionError(null);
    setBusyId(project.id);
    try {
      const copy = await duplicateProject(project.id);
      setProjects((prev) => [copy, ...prev]);
      setNotice(t("projects.duplicateNotice", { title: copy.title }));
    } catch (err) {
      setActionError(describeError(err, t));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(project: GuestProjectSummary) {
    const confirmed = await requestConfirm({
      message: t("projects.confirmDelete", { title: project.title }),
      confirmLabel: t("projects.delete"),
      danger: true,
    });
    if (!confirmed) return;
    setActionError(null);
    setBusyId(project.id);
    try {
      await deleteProject(project.id);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
    } catch (err) {
      setActionError(describeError(err, t));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{t("guestProjects.heading")}</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{t("guestProjects.subheading")}</p>
        </div>
        <button
          type="button"
          onClick={openCreateDialog}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {t("projects.new")}
        </button>
      </div>

      {showCreateDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
          onMouseDown={closeCreateDialog}
        >
          <div
            ref={createDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("projects.newProjectHeading")}
            className="w-full max-w-sm rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-4 shadow-[var(--shadow-modal)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-semibold">{t("projects.newProjectHeading")}</h3>
            <label className="mb-1 block text-xs text-[var(--text-muted)]" htmlFor="new-guest-project-title">
              {t("projects.projectNameLabel")}
            </label>
            <input
              id="new-guest-project-title"
              ref={newProjectInputRef}
              value={newProjectTitle}
              onChange={(e) => setNewProjectTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
              }}
              placeholder={t("projects.projectNamePlaceholder")}
              className="mb-4 w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeCreateDialog}
                className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {t("projects.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating}
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {creating ? t("projects.creating") : t("projects.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className="mb-4 rounded-md border border-[var(--outpost-border)] bg-[var(--outpost-soft)] px-3 py-2 text-sm text-[var(--outpost)]">
          {notice}
          <button type="button" onClick={() => setNotice(null)} className="ml-3 underline">
            {t("projects.dismiss")}
          </button>
        </div>
      )}
      {actionError && (
        <div className="mb-4 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {actionError}
        </div>
      )}

      {loadState.status === "loading" && (
        <p className="text-[var(--text-muted)]">{t("projects.loading")}</p>
      )}
      {loadState.status === "error" && (
        <p className="text-[var(--danger)]">{t("projects.loadError", { message: loadState.message })}</p>
      )}

      {loadState.status === "ready" && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] px-4 py-10 text-center text-[var(--text-muted)]">
          <p>{t("guestProjects.empty")}</p>
        </div>
      )}

      {loadState.status === "ready" && projects.length > 0 && (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)]">
          {projects.map((project) => {
            const isRenaming = renamingId === project.id;
            const isBusy = busyId === project.id;

            return (
              <li key={project.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRename(project);
                        if (e.key === "Escape") cancelRename();
                      }}
                      className="w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpenProject(project)}
                      className="truncate text-left font-medium text-[var(--text-primary)] hover:underline"
                      title={t("projects.openTitle")}
                    >
                      {project.title}
                    </button>
                  )}
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                    {t("guestProjects.updatedAt", {
                      date: new Date(project.updatedAt).toLocaleString(i18n.language),
                    })}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2 text-sm">
                  {isRenaming ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void submitRename(project)}
                        disabled={isBusy}
                        className="rounded-md bg-[var(--accent)] px-2 py-1 text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                      >
                        {t("projects.save")}
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        className="rounded-md px-2 py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      >
                        {t("projects.cancel")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => startRename(project)}
                        disabled={isBusy}
                        className="rounded-md px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                      >
                        {t("projects.rename")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDuplicate(project)}
                        disabled={isBusy}
                        className="rounded-md px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                      >
                        {t("projects.duplicate")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(project)}
                        disabled={isBusy}
                        className="rounded-md px-2 py-1 text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-50"
                      >
                        {t("projects.delete")}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}

function describeError(err: unknown, t: TFunction<"app">): string {
  return err instanceof Error ? err.message : t("projects.error.generic");
}
