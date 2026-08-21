// Public-link work: "add a public link option to the share menu" — anyone
// with the direct URL, logged in or not, can view a project read-only,
// including live collaborative updates over the same realtime transport
// every other viewer already uses. Three routes:
//   - `PATCH /api/projects/:id/visibility` (owner-only, session-
//     authenticated): flips `projects.visibility` between `"private"` and
//     `"link"` — the single on/off toggle `SharingPanel.tsx`'s new "Public
//     link" section drives. Never accepts `"public"` (a searchable gallery
//     listing) even though the column/type allows it — see
//     `store.ts`'s `updateVisibility` doc comment for why that's a
//     deliberately separate, later feature.
//   - `GET /api/public/:shortId` (no auth): the public preview — same shape
//     and "don't distinguish not-found from not-shared" reasoning as
//     `inviteRoutes.ts`'s own `GET /api/invites/:token`.
//   - `POST /api/public/:shortId/realtime-ticket` (no auth): mints a
//     60-second viewer-role ticket for a synthetic `guest:...` id (see
//     `@scm/doc-storage`'s `PUBLIC_GUEST_ID_PREFIX`/`resolveRole` doc
//     comments for how that id is re-verified, with zero special-casing
//     needed in `apps/realtime`, at every reconnect and on the hourly
//     revocation sweep) — `apps/web`'s `usePublicProjectDocument.ts` fetches
//     this the same way `useProjectDocument.ts` fetches the authenticated
//     one, just keyed by `shortId` instead of a session cookie.
import crypto from "node:crypto";

import { PUBLIC_GUEST_ID_PREFIX } from "@scm/doc-storage";
import type { FastifyPluginAsync } from "fastify";

import { notifyRealtimeMembershipChanged } from "../realtime/notify.js";
import { mintRealtimeTicket, REALTIME_TICKET_TTL_SECONDS } from "../realtime/ticket.js";
import { resolveRole } from "./roles.js";
import { findActiveProjectById, findActiveProjectByShortId, updateVisibility } from "./store.js";

function isPublicVisibility(value: unknown): value is "private" | "link" {
  return value === "private" || value === "link";
}

export const projectPublicRoutes: FastifyPluginAsync = async (fastify) => {
  /** Toggles the public-link setting — owner-only, same access rule `inviteRoutes.ts` uses for creating an invite. */
  fastify.patch<{ Params: { id: string }; Body: { visibility?: string } }>(
    "/api/projects/:id/visibility",
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
      if (role !== "owner") {
        return reply.code(403).send({ error: "forbidden", detail: "only the owner can change link sharing" });
      }

      const visibility = request.body?.visibility;
      if (!isPublicVisibility(visibility)) {
        return reply.code(400).send({ error: "invalid_visibility" });
      }

      const updated = await updateVisibility(id, visibility);

      // Turning link-sharing off should disconnect any currently-connected
      // public viewers immediately, not wait for the hourly revocation
      // sweep — reuses the exact same webhook a role change/removal already
      // triggers (omitting `userId` reconciles every live connection on the
      // project, not just one member's — see `notify.ts`'s own doc comment).
      // Fire-and-forget for the same reason every other call site is: a
      // slow/unreachable apps/realtime must never make this REST call itself
      // slow or fail.
      notifyRealtimeMembershipChanged(id).catch((err: unknown) => {
        request.log.error({ err }, "failed to notify apps/realtime of a visibility change");
      });

      return reply.send({ visibility: updated.visibility });
    },
  );

  /**
   * Public preview — no auth required, mirrors `GET /api/invites/:token`'s
   * "don't distinguish not-found from not-shared" reasoning (a 404 for a
   * private project would confirm its short_id resolves to something real).
   */
  fastify.get<{ Params: { shortId: string } }>("/api/public/:shortId", async (request, reply) => {
    const project = await findActiveProjectByShortId(request.params.shortId);
    if (!project || project.visibility === "private") {
      return reply.code(200).send({ valid: false });
    }
    return reply.send({ valid: true, projectId: project.id, projectTitle: project.title });
  });

  /** Mints a viewer-role realtime ticket for an anonymous visitor — see this file's header comment. */
  fastify.post<{ Params: { shortId: string } }>(
    "/api/public/:shortId/realtime-ticket",
    async (request, reply) => {
      const project = await findActiveProjectByShortId(request.params.shortId);
      if (!project || project.visibility === "private") {
        return reply.code(404).send({ error: "not_shared" });
      }

      const ticket = mintRealtimeTicket({
        userId: `${PUBLIC_GUEST_ID_PREFIX}${crypto.randomUUID()}`,
        projectId: project.id,
        role: "viewer",
      });
      return reply.send({ ticket, expiresInSeconds: REALTIME_TICKET_TTL_SECONDS, role: "viewer" });
    },
  );
};
