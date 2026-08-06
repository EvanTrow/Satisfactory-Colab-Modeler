import { useEffect, useState } from "react";

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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

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
        setLoadState({ status: "error", message: describeError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    setActionError(null);
    setCreating(true);
    try {
      const project = await createProject();
      setProjects((prev) => [project, ...prev]);
    } catch (err) {
      setActionError(describeError(err));
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
      setActionError(describeError(err));
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
      // Job 006's explicit limitation (apps/api/src/projects/store.ts's
      // duplicateProject doc comment): there's no CRDT document to
      // duplicate yet (Job 015), so only the project's title/settings were
      // cloned. Surfaced here rather than silently implying a full copy.
      setNotice(`"${copy.title}" was created. Note: only the project's settings were copied — canvas content duplication isn't available yet.`);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(project: ProjectSummary) {
    if (!window.confirm(`Delete "${project.title}"? This can't be undone from the UI yet.`)) {
      return;
    }
    setActionError(null);
    setBusyId(project.id);
    try {
      await deleteProject(project.id);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Your projects</h2>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {creating ? "Creating…" : "New project"}
        </button>
      </div>

      {notice && (
        <div className="mb-4 rounded-md border border-[var(--outpost-border)] bg-[var(--outpost-soft)] px-3 py-2 text-sm text-[var(--outpost)]">
          {notice}
          <button type="button" onClick={() => setNotice(null)} className="ml-3 underline">
            Dismiss
          </button>
        </div>
      )}
      {actionError && (
        <div className="mb-4 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {actionError}
        </div>
      )}

      {loadState.status === "loading" && <p className="text-[var(--text-muted)]">Loading projects…</p>}
      {loadState.status === "error" && (
        <p className="text-[var(--danger)]">Couldn't load projects: {loadState.message}</p>
      )}

      {loadState.status === "ready" && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] px-4 py-10 text-center text-[var(--text-muted)]">
          <p>No projects yet — create one to get started.</p>
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
                      title="Open project"
                    >
                      {project.title}
                    </button>
                  )}
                  <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                    {project.role} · updated {new Date(project.updatedAt).toLocaleString()}
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
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        className="rounded-md px-2 py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      >
                        Cancel
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
                          Rename
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDuplicate(project)}
                        disabled={isBusy}
                        className="rounded-md px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                      >
                        Duplicate
                      </button>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => void handleDelete(project)}
                          disabled={isBusy}
                          className="rounded-md px-2 py-1 text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-50"
                        >
                          Delete
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

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You don't have permission to do that.";
    if (err.status === 404) return "That project doesn't exist (or you don't have access to it).";
    return `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
