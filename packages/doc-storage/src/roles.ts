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
 * Public-link work: the `sub` prefix a public (anonymous, no session)
 * viewer's realtime ticket carries instead of a real `users.id` — minted by
 * `apps/api`'s public-share routes once `projects.visibility !== 'private'`
 * has been confirmed, one fresh random suffix per connection (never a real
 * user, never reused). `resolveRole` below special-cases any `userId`
 * carrying this prefix rather than looking it up in `project_members` (there
 * is no row for it — a public viewer is never a member), and
 * `apps/realtime/src/server.ts`'s `onStoreDocument` uses this same prefix to
 * make sure a guest id is never written to `project_doc_updates.actor_user_id`
 * (a real `uuid` foreign key into `users`).
 */
export const PUBLIC_GUEST_ID_PREFIX = "guest:";

/**
 * Resolves a user's role on a project — from `project_members` for a real
 * (session-authenticated) user, the single source of truth for "can this
 * user see/act on this project." Returns `null` if the user has no
 * `project_members` row for this project at all (never a member, or was
 * removed), which every caller (REST routes and the Hocuspocus
 * `onAuthenticate` hook alike) treats as "acts like the project doesn't
 * exist" rather than a distinguishable 403 — this avoids leaking whether a
 * given project id exists to a non-member.
 *
 * Public-link work: a `userId` carrying `PUBLIC_GUEST_ID_PREFIX` instead
 * resolves against `projects.visibility` directly — always `"viewer"` while
 * the project's link-sharing is on (`"link"` or `"public"`), `null` the
 * instant it's turned back to `"private"` or the project is deleted. This is
 * what makes a public viewer's connection re-verify and force-disconnect via
 * the exact same mechanism (`apps/realtime/src/revocation.ts`'s hourly sweep
 * and pushed reconciliation) a real member's revoked access already does —
 * no separate "public session" bookkeeping needed.
 */
export async function resolveRole(projectId: string, userId: string): Promise<ProjectMemberRole | null> {
  if (userId.startsWith(PUBLIC_GUEST_ID_PREFIX)) {
    const project = await db
      .selectFrom("projects")
      .select("visibility")
      .where("id", "=", projectId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return project && project.visibility !== "private" ? "viewer" : null;
  }

  const row = await db
    .selectFrom("project_members")
    .select("role")
    .where("project_id", "=", projectId)
    .where("user_id", "=", userId)
    .executeTakeFirst();

  return row?.role ?? null;
}
