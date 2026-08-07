// Job 020 / PLAN.md §6: `GET /api/realtime/ticket?projectId=…` — session-
// cookie-authenticated (same `fastify.authenticate` preHandler every other
// project route uses), resolves the caller's role from `project_members`
// exactly like every other project route (`roles.ts`'s `resolveRole` — "no
// membership row at all" is treated as 404, never a distinguishable 403,
// per that module's own doc comment on not leaking project existence), and
// mints a 60-second signed ticket only if a role exists. `apps/web`'s
// `HocuspocusProvider` fetches a fresh one from here immediately before
// every connection attempt (initial connect *and* every reconnect) via its
// `token` option's function form — never caches one, since the ticket is
// deliberately too short-lived to reuse.
import type { FastifyPluginAsync } from "fastify";

import { resolveRole } from "../projects/roles.js";
import { findActiveProjectById } from "../projects/store.js";
import { mintRealtimeTicket, REALTIME_TICKET_TTL_SECONDS } from "../realtime/ticket.js";

export const realtimeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId?: string } }>(
    "/api/realtime/ticket",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const { projectId } = request.query;

      if (typeof projectId !== "string" || projectId.length === 0) {
        return reply.code(400).send({ error: "missing_project_id" });
      }

      const role = await resolveRole(projectId, user.id);
      if (role === null) {
        // Same "acts like the project doesn't exist" 404 every other
        // project route uses for a non-member — see roles.ts's doc comment.
        return reply.code(404).send({ error: "project_not_found" });
      }
      const project = await findActiveProjectById(projectId);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found" });
      }

      const ticket = mintRealtimeTicket({ userId: user.id, projectId, role });
      return reply.send({ ticket, expiresInSeconds: REALTIME_TICKET_TTL_SECONDS, role });
    },
  );
};
