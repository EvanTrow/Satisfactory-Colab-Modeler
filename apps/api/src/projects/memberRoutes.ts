// Job 020: deliberately minimal member-management routes — owner-only
// list/change-role/remove for an *existing* `project_members` row. Full
// share-by-link + invite tokens are explicitly Job 022's "sharing" scope
// (see `jobs/INDEX.md`'s row for it); this job needs *some* real way for
// "a project owner revoking a member's access" (this job's own acceptance
// criteria wording) to actually happen against the running app, both for
// the automated test below and for manual two-browser-tab verification —
// without these routes there would be no way to exercise the revocation
// mechanism at all short of writing directly to Postgres. Job 022 should
// treat this file as a starting point to extend (invite tokens, email,
// pending-invite state), not as the finished feature.
import type { FastifyPluginAsync } from "fastify";

import { resolveRole } from "./roles.js";
import { findActiveProjectById, listMembers, removeMember, updateMemberRole } from "./store.js";
import { notifyRealtimeMembershipChanged } from "../realtime/notify.js";

function isAssignableRole(value: unknown): value is "editor" | "viewer" {
  return value === "editor" || value === "viewer";
}

export const projectMemberRoutes: FastifyPluginAsync = async (fastify) => {
  /** Lists a project's members. Any member (owner/editor/viewer) can view the list. */
  fastify.get<{ Params: { id: string } }>(
    "/api/projects/:id/members",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;

      const role = await resolveRole(id, user.id);
      if (role === null) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const project = await findActiveProjectById(id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found" });
      }

      return reply.send(await listMembers(id));
    },
  );

  /**
   * Changes an existing member's role — owner-only. Notifies
   * `apps/realtime` (best-effort, fire-and-forget from this route's
   * perspective — see `notify.ts`'s doc comment) so an active connection
   * for the affected member is force-disconnected rather than continuing
   * under its stale role until the hourly re-verification sweep catches it.
   */
  fastify.patch<{ Params: { id: string; userId: string }; Body: { role?: string } }>(
    "/api/projects/:id/members/:userId",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const { id, userId } = request.params;

      const role = await resolveRole(id, user.id);
      if (role === null) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const project = await findActiveProjectById(id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      if (role !== "owner") {
        return reply.code(403).send({ error: "forbidden", detail: "only the owner can change a member's role" });
      }
      if (userId === project.owner_id) {
        return reply.code(400).send({ error: "cannot_change_owner_role" });
      }

      const nextRole = request.body?.role;
      if (!isAssignableRole(nextRole)) {
        return reply.code(400).send({ error: "invalid_role" });
      }

      const targetRole = await resolveRole(id, userId);
      if (targetRole === null) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      await updateMemberRole(id, userId, nextRole);
      notifyRealtimeMembershipChanged(id, userId).catch((err: unknown) => {
        request.log.error({ err }, "failed to notify apps/realtime of a member role change");
      });

      return reply.code(204).send();
    },
  );

  /** Removes a member entirely — owner-only. Same notify-and-don't-block pattern as the role-change route above. */
  fastify.delete<{ Params: { id: string; userId: string } }>(
    "/api/projects/:id/members/:userId",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const { id, userId } = request.params;

      const role = await resolveRole(id, user.id);
      if (role === null) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const project = await findActiveProjectById(id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      if (role !== "owner") {
        return reply.code(403).send({ error: "forbidden", detail: "only the owner can remove a member" });
      }
      if (userId === project.owner_id) {
        return reply.code(400).send({ error: "cannot_remove_owner" });
      }

      const targetRole = await resolveRole(id, userId);
      if (targetRole === null) {
        return reply.code(404).send({ error: "member_not_found" });
      }

      await removeMember(id, userId);
      notifyRealtimeMembershipChanged(id, userId).catch((err: unknown) => {
        request.log.error({ err }, "failed to notify apps/realtime of a member removal");
      });

      return reply.code(204).send();
    },
  );
};
