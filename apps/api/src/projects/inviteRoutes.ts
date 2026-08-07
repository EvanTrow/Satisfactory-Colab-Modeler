// Job 022: real sharing UI backend — invite creation/listing/revocation
// (owner-only, extending Job 020's minimal `memberRoutes.ts` the same way
// that file's own header comment invited) plus public preview + redemption
// (any authenticated user, not project-scoped — a token IS the
// authorization, same as a session cookie).
import type { ProjectMemberRole } from "@scm/db";
import type { FastifyPluginAsync } from "fastify";

import {
  createInvite,
  listInvites,
  lookupInviteByToken,
  redeemInvite,
  revokeInvite,
  type CreateInviteInput,
} from "./invites.js";
import { notifyRealtimeMembershipChanged } from "../realtime/notify.js";
import { resolveRole } from "./roles.js";
import { findActiveProjectById } from "./store.js";

function isInviteRole(value: unknown): value is "editor" | "viewer" {
  return value === "editor" || value === "viewer";
}

/** camelCase wire shape for an invite — never includes the token or its hash (the token only ever appears once, in `createInvite`'s own response). */
interface SerializedInvite {
  id: string;
  role: "editor" | "viewer";
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  createdBy: string;
}

function serializeInvite(invite: {
  id: string;
  role: ProjectMemberRole | "editor" | "viewer";
  expires_at: Date | string | null;
  max_uses: number | null;
  uses: number;
  created_by: string;
}): SerializedInvite {
  return {
    id: invite.id,
    role: invite.role as "editor" | "viewer",
    expiresAt: invite.expires_at ? new Date(invite.expires_at).toISOString() : null,
    maxUses: invite.max_uses,
    uses: invite.uses,
    createdBy: invite.created_by,
  };
}

export const projectInviteRoutes: FastifyPluginAsync = async (fastify) => {
  /** Creates an invite — owner-only, same access rule `memberRoutes.ts` uses for role changes/removal (sharing access is an ownership-level decision). */
  fastify.post<{
    Params: { id: string };
    Body: { role?: string; expiresAt?: string | null; maxUses?: number | null };
  }>("/api/projects/:id/invites", { preHandler: fastify.authenticate }, async (request, reply) => {
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
      return reply.code(403).send({ error: "forbidden", detail: "only the owner can create invites" });
    }

    const inviteRole = request.body?.role;
    if (!isInviteRole(inviteRole)) {
      return reply.code(400).send({ error: "invalid_role" });
    }

    let expiresAt: Date | null = null;
    if (request.body?.expiresAt !== undefined && request.body.expiresAt !== null) {
      const parsed = new Date(request.body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return reply.code(400).send({ error: "invalid_expires_at" });
      }
      expiresAt = parsed;
    }

    const rawMaxUses = request.body?.maxUses;
    let maxUses: number | null = null;
    if (rawMaxUses !== undefined && rawMaxUses !== null) {
      if (typeof rawMaxUses !== "number" || !Number.isInteger(rawMaxUses) || rawMaxUses < 1) {
        return reply.code(400).send({ error: "invalid_max_uses" });
      }
      maxUses = rawMaxUses;
    }

    const input: CreateInviteInput = { projectId: id, role: inviteRole, createdBy: user.id, expiresAt, maxUses };
    const { token, invite } = await createInvite(input);

    return reply.code(201).send({ ...serializeInvite(invite), token });
  });

  /** Lists a project's invites — owner-only. Never includes tokens. */
  fastify.get<{ Params: { id: string } }>(
    "/api/projects/:id/invites",
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
        return reply.code(403).send({ error: "forbidden", detail: "only the owner can view invites" });
      }

      const invites = await listInvites(id);
      return reply.send(invites.map(serializeInvite));
    },
  );

  /** Revokes an invite — owner-only. */
  fastify.delete<{ Params: { id: string; inviteId: string } }>(
    "/api/projects/:id/invites/:inviteId",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const { id, inviteId } = request.params;

      const role = await resolveRole(id, user.id);
      if (role === null) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const project = await findActiveProjectById(id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      if (role !== "owner") {
        return reply.code(403).send({ error: "forbidden", detail: "only the owner can revoke an invite" });
      }

      const revoked = await revokeInvite(id, inviteId);
      if (!revoked) {
        return reply.code(404).send({ error: "invite_not_found" });
      }
      return reply.code(204).send();
    },
  );

  /**
   * Public invite preview — no auth required, so an unauthenticated visitor
   * following a share link can see what they're being invited to (and be
   * prompted to log in) before committing to anything. Deliberately does
   * NOT require project membership (a link recipient is by definition not a
   * member yet).
   */
  fastify.get<{ Params: { token: string } }>("/api/invites/:token", async (request, reply) => {
    const lookup = await lookupInviteByToken(request.params.token);
    if (lookup.status !== "valid") {
      return reply.code(200).send({ valid: false, reason: lookup.status });
    }

    const project = await findActiveProjectById(lookup.invite.project_id);
    if (!project) {
      return reply.code(200).send({ valid: false, reason: "not_found" });
    }

    return reply.send({
      valid: true,
      projectId: project.id,
      projectTitle: project.title,
      role: lookup.invite.role,
    });
  });

  /**
   * Redeems an invite — requires login (the redeemer must be *someone*,
   * even if they're new to this project), but is NOT project-scoped by
   * `fastify.authenticate` in any role sense: possessing the raw token is
   * exactly what authorizes this, matching a session cookie's own "the
   * bearer of the value is the authorization" model.
   */
  fastify.post<{ Params: { token: string } }>(
    "/api/invites/:token/redeem",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const result = await redeemInvite(request.params.token, user.id);

      if (result.status !== "redeemed") {
        return reply.code(410).send({ error: "invite_" + result.status });
      }

      // Job 020's revoke webhook is framed as "membership changed" — a new
      // member joining is the same category of event as one being removed
      // or having their role changed. Nothing currently needs a *live*
      // connection to react to a brand-new member (there's no stale
      // connection to force-disconnect the way a downgrade/removal has),
      // but this keeps `apps/realtime` informed in case a future extension
      // wants to react to it (e.g. proactively refreshing a member list a
      // connected owner is looking at) — best-effort, same
      // fire-and-forget pattern `memberRoutes.ts` already uses.
      notifyRealtimeMembershipChanged(result.projectId, user.id).catch((err: unknown) => {
        request.log.error({ err }, "failed to notify apps/realtime of an invite redemption");
      });

      return reply.send({ projectId: result.projectId, role: result.role, alreadyMember: result.alreadyMember });
    },
  );
};
