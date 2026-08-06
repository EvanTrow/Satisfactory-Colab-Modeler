import type { Project, ProjectMemberRole } from "@scm/db";
import type { FastifyPluginAsync } from "fastify";

import { canDelete, canDuplicate, canEdit, resolveRole } from "./roles.js";
import {
  createProject,
  duplicateProject,
  findActiveProjectById,
  listProjectsForUser,
  renameProject,
  softDeleteProject,
  type ProjectWithRole,
} from "./store.js";

/**
 * Registers the project CRUD routes (Job 006 / PLAN.md §3 "Platform" +
 * §4 "Identity, projects, sharing"):
 *   - `POST /api/projects`
 *   - `GET /api/projects`
 *   - `PATCH /api/projects/:id`
 *   - `POST /api/projects/:id/duplicate`
 *   - `DELETE /api/projects/:id`
 *
 * Every route requires a logged-in user (`{ preHandler: fastify.authenticate }`
 * from `auth/session-plugin.ts`, registered globally in `app.ts`) and,
 * except for create/list, resolves the caller's role from
 * `project_members` via `roles.ts` and enforces it — see that module's
 * doc comments for the exact rules.
 */
export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { title?: string } }>(
    "/api/projects",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const title = typeof request.body?.title === "string" ? request.body.title : undefined;
      const result = await createProject(user.id, title);
      return reply.code(201).send(serializeProject(result));
    },
  );

  fastify.get("/api/projects", { preHandler: fastify.authenticate }, async (request, reply) => {
    const user = request.user!;
    const projects = await listProjectsForUser(user.id);
    return reply.send(projects.map(serializeProject));
  });

  fastify.patch<{ Params: { id: string }; Body: { title?: string } }>(
    "/api/projects/:id",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;

      const role = await resolveRole(id, user.id);
      if (role === null) {
        // No membership row at all: treat exactly like "doesn't exist"
        // rather than leaking that the id belongs to someone else's
        // project (see roles.ts's doc comment).
        return reply.code(404).send({ error: "project_not_found" });
      }

      const project = await findActiveProjectById(id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found" });
      }

      if (!canEdit(role)) {
        return reply.code(403).send({ error: "forbidden", detail: "viewer cannot edit this project" });
      }

      const rawTitle = request.body?.title;
      if (typeof rawTitle !== "string" || rawTitle.trim().length === 0) {
        return reply.code(400).send({ error: "invalid_title" });
      }

      const updated = await renameProject({ projectId: id, title: rawTitle.trim() });
      return reply.send(serializeProject({ project: updated, role }));
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/projects/:id/duplicate",
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

      if (!canDuplicate(role)) {
        // Unreachable today (canDuplicate accepts any non-null role), kept
        // for symmetry with the other routes and in case that policy tightens.
        return reply.code(403).send({ error: "forbidden" });
      }

      const result = await duplicateProject(project, user.id);
      return reply.code(201).send({
        ...serializeProject(result),
        // Flagged explicitly in the response (not just in code comments —
        // see store.ts's duplicateProject TODO) so `apps/web` can surface
        // this to the user rather than silently implying a full copy:
        // there is no CRDT document to duplicate yet (Job 015), so only
        // the project's metadata row was cloned.
        metadataOnly: true,
      });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
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

      if (!canDelete(role)) {
        return reply.code(403).send({ error: "forbidden", detail: "only the owner can delete this project" });
      }

      await softDeleteProject(id);
      return reply.code(204).send();
    },
  );
};

/** camelCase JSON shape returned to `apps/web` for a project + the caller's role on it. */
interface SerializedProject {
  id: string;
  shortId: string;
  ownerId: string;
  title: string;
  visibility: Project["visibility"];
  gameDataVersion: string;
  createdAt: Project["created_at"];
  updatedAt: Project["updated_at"];
  role: ProjectMemberRole;
}

function serializeProject({ project, role }: ProjectWithRole): SerializedProject {
  return {
    id: project.id,
    shortId: project.short_id,
    ownerId: project.owner_id,
    title: project.title,
    visibility: project.visibility,
    gameDataVersion: project.game_data_version,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    role,
  };
}
