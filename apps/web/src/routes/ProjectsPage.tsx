import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { useFocusTrap } from "../a11y/useFocusTrap";
import {
  ApiError,
  createProject,
  deleteProject,
  duplicateProject,
  listProjects,
  renameProject,
  type ProjectSummary,
} from "../api/projects";

interface ProjectsPageProps {
  /** Called when the user opens a project — Job 006 has no canvas yet, so the caller renders a placeholder. */
  onOpenProject: (project: ProjectSummary) => void;
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

/**
 * The post-login landing page (PLAN.md §3 "Platform": "project list with
 * create/rename/duplicate/soft-delete"). Talks to `apps/api`'s
 * `/api/projects` routes via `../api/projects.ts`.
 *
 * Role gating mirrors `apps/api/src/projects/roles.ts` exactly: rename is
 * offered for `owner`/`editor`, delete only for `owner`, duplicate for any
 * role (a member can always "make their own copy"). The server is the
 * actual enforcement point — hiding a button here is a UX nicety, not the
 * security boundary — but keeping the two in sync avoids a confusing
 * "why did that 403" experience.
 */
export function ProjectsPage({ onOpenProject }: ProjectsPageProps) {
  // `i18n.language` (not just `t`) is used directly for `toLocaleString` below —
  // Job 028: a genuinely locale-aware date format (day/month order, calendar
  // script) that has nothing to do with the `translation`/`app` string
  // tables, but should still track the user's chosen display locale.
  const { t, i18n } = useTranslation("app");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  // New-project naming dialog (asked up front rather than silently creating
  // an "My Factory" and requiring a separate rename afterward).
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const createDialogRef = useRef<HTMLDivElement>(null);
  const newProjectInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(createDialogRef, showCreateDialog, {
    onClose: () => setShowCreateDialog(false),
    initialFocusRef: newProjectInputRef,
  });

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
  }, []);

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

  function startRename(project: ProjectSummary) {
    setActionError(null);
    setRenamingId(project.id);
    setRenameDraft(project.title);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft("");
  }

  async function submitRename(project: ProjectSummary) {
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

  async function handleDuplicate(project: ProjectSummary) {
    setActionError(null);
    setBusyId(project.id);
    try {
      const copy = await duplicateProject(project.id);
      setProjects((prev) => [copy, ...prev]);
      // Job 015: duplication now copies the source project's current canvas
      // content too (apps/api/src/projects/store.ts's duplicateProject),
      // not just its title/settings — the "settings only" caveat this
      // notice used to carry (Job 006-014) no longer applies.
      setNotice(t("projects.duplicateNotice", { title: copy.title }));
    } catch (err) {
      setActionError(describeError(err, t));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(project: ProjectSummary) {
    if (!window.confirm(t("projects.confirmDelete", { title: project.title }))) {
      return;
    }
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
        <h2 className="text-xl font-semibold tracking-tight">{t("projects.heading")}</h2>
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
            <label
              className="mb-1 block text-xs text-[var(--text-muted)]"
              htmlFor="new-project-title"
            >
              {t("projects.projectNameLabel")}
            </label>
            <input
              id="new-project-title"
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
        <p className="text-[var(--danger)]">
          {t("projects.loadError", { message: loadState.message })}
        </p>
      )}

      {loadState.status === "ready" && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] px-4 py-10 text-center text-[var(--text-muted)]">
          <p>{t("projects.empty")}</p>
        </div>
      )}

      {loadState.status === "ready" && projects.length > 0 && (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)]">
          {projects.map((project) => {
            const isRenaming = renamingId === project.id;
            const isBusy = busyId === project.id;
            const canEdit = project.role === "owner" || project.role === "editor";
            const canDelete = project.role === "owner";

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
                    {t("projects.updatedAt", {
                      role: t(`projects.role.${project.role}`),
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
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => startRename(project)}
                          disabled={isBusy}
                          className="rounded-md px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                        >
                          {t("projects.rename")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDuplicate(project)}
                        disabled={isBusy}
                        className="rounded-md px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                      >
                        {t("projects.duplicate")}
                      </button>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => void handleDelete(project)}
                          disabled={isBusy}
                          className="rounded-md px-2 py-1 text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-50"
                        >
                          {t("projects.delete")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// `t` is passed in rather than calling `useTranslation()` here — this is a
// plain function, not a component/hook, called from event handlers rather
// than render.
function describeError(err: unknown, t: TFunction<"app">): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return t("projects.error.forbidden");
    if (err.status === 404) return t("projects.error.notFound");
    return t("projects.error.requestFailed", { status: err.status });
  }
  return err instanceof Error ? err.message : t("projects.error.generic");
}
