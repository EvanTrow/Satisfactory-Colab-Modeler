import type { ProjectMemberRole } from "@scm/db";

// Job 020: `resolveRole` itself moved to `@scm/doc-storage` (verbatim), since
// `apps/realtime`'s Hocuspocus `onAuthenticate` hook needs the exact same
// query to re-check a role at connect time (PLAN.md §6) — see that
// package's `roles.ts` for the moved implementation and full rationale.
// Re-exported here so every existing `apps/api` call site
// (`import { resolveRole } from "./roles.js"`) is unaffected; every project
// has exactly one `owner` row (created alongside the project itself in
// `createProject`), so this same lookup covers both "am I the owner" and
// "am I a shared collaborator" — there's no separate owner_id check needed
// anywhere else in the routes.
export { resolveRole } from "@scm/doc-storage";

/** Roles allowed to rename/edit project metadata (PATCH). Viewers cannot. */
export function canEdit(role: ProjectMemberRole | null): boolean {
  return role === "owner" || role === "editor";
}

/** Only the owner can soft-delete a project. */
export function canDelete(role: ProjectMemberRole | null): boolean {
  return role === "owner";
}

/**
 * Any member (owner/editor/viewer) can duplicate a project — duplicating
 * creates a *new* project owned by the duplicator and never mutates the
 * original, so it's treated like "make a copy," not an edit of the source.
 */
export function canDuplicate(role: ProjectMemberRole | null): boolean {
  return role !== null;
}
