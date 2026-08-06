import type { ProjectMemberRole } from "@scm/db";

import { db } from "../db.js";

/**
 * Resolves the caller's role on a project from `project_members` — the
 * single source of truth for "can this user see/act on this project."
 * Returns `null` if the user has no `project_members` row for this project
 * at all (never a member, or was removed), which callers treat as "acts
 * like the project doesn't exist" (404) rather than a 403 — this avoids
 * leaking whether a given project id exists to a non-member.
 *
 * Every project has exactly one `owner` row (created alongside the project
 * itself in `createProject`), so this same lookup covers both "am I the
 * owner" and "am I a shared collaborator" — there's no separate owner_id
 * check needed anywhere else in the routes.
 */
export async function resolveRole(projectId: string, userId: string): Promise<ProjectMemberRole | null> {
  const row = await db
    .selectFrom("project_members")
    .select("role")
    .where("project_id", "=", projectId)
    .where("user_id", "=", userId)
    .executeTakeFirst();

  return row?.role ?? null;
}

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
