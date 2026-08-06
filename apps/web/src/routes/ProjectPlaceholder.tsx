import type { ProjectSummary } from "../api/projects";

interface ProjectPlaceholderProps {
  project: ProjectSummary;
  onBack: () => void;
}

/**
 * Stands in for the canvas/editor a project opens into. Explicitly out of
 * scope for Job 006 (PLAN.md's Phase 2, starting at Job 007, builds the
 * actual React Flow canvas) — this just proves the project-list -> project
 * navigation works end to end.
 */
export function ProjectPlaceholder({ project, onBack }: ProjectPlaceholderProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <button type="button" onClick={onBack} className="mb-6 text-sm text-neutral-400 underline hover:text-neutral-200">
        ← Back to projects
      </button>
      <h2 className="text-xl font-semibold tracking-tight">{project.title}</h2>
      <p className="mt-2 text-neutral-400">
        The canvas editor doesn't exist yet — it's built starting with Job 007 (Phase 2). This placeholder just
        confirms the project list can navigate into a project.
      </p>
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-neutral-400">
        <dt className="text-neutral-500">Short id</dt>
        <dd>{project.shortId}</dd>
        <dt className="text-neutral-500">Your role</dt>
        <dd>{project.role}</dd>
        <dt className="text-neutral-500">Visibility</dt>
        <dd>{project.visibility}</dd>
      </dl>
    </div>
  );
}
