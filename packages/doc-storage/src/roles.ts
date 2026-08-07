// Job 020: `resolveRole` moved here (not duplicated) from
// `apps/api/src/projects/roles.ts` because `apps/realtime`'s Hocuspocus
// `onAuthenticate` hook needs the exact same "does this user have a
// `project_members` row for this project, and if so what role" query — per
// PLAN.md §6: "RE-CHECK the role against Postgres so revocations apply at
// connect time," using the same source of truth `apps/api`'s ticket route
// used to mint the ticket in the first place. `apps/api/src/projects/roles.ts`
// re-exports this rather than keeping its own copy, so there is exactly one
// definition of "how a role is resolved" in the whole repo. That file still
// owns `canEdit`/`canDelete`/`canDuplicate` — those are REST-route-specific
// authorization helpers with no meaning for a Hocuspocus connection, so they
// stay put rather than migrating here.
import type { ProjectMemberRole } from "@scm/db";

import { db } from "./db.js";

/**
 * Resolves a user's role on a project from `project_members` — the single
 * source of truth for "can this user see/act on this project." Returns
 * `null` if the user has no `project_members` row for this project at all
 * (never a member, or was removed), which every caller (REST routes and the
 * Hocuspocus `onAuthenticate` hook alike) treats as "acts like the project
 * doesn't exist" rather than a distinguishable 403 — this avoids leaking
 * whether a given project id exists to a non-member.
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
