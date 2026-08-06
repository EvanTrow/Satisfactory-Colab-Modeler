// REST surface over `docStorage.ts` — a simple debounced push/pull, per Job
// 015's scope: "This job does not yet require a live WebSocket... Job 020
// (Hocuspocus) will later replace/extend this transport, not the storage
// model." Bytes travel over the wire as base64 inside a small JSON envelope
// (`{ update: string }`) rather than raw `application/octet-stream` —
// Fastify has no built-in body parser for arbitrary binary content types
// (it would need a custom `addContentTypeParser`), and the update sizes
// here are small (a single node move, PLAN.md's own "writes are O(change)"
// framing) — base64's ~33% overhead is immaterial at that size and this
// keeps every route in `apps/api` going through the same default JSON body
// parser rather than special-casing one route.
import type { FastifyPluginAsync } from "fastify";

import { canEdit, resolveRole } from "./roles.js";
import { findActiveProjectById } from "./store.js";
import { appendUpdate, loadProjectDocUpdate } from "./docStorage.js";

export const projectDocRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Fetches the project's current document state — snapshot + logs, merged
   * server-side via `Y.applyUpdate` — as a single Yjs update the client
   * applies into a fresh local doc with `Y.applyUpdate(doc, bytes)`. Any
   * project member (including a viewer) can load; loading is read-only.
   */
  fastify.get<{ Params: { id: string } }>(
    "/api/projects/:id/doc",
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

      const update = await loadProjectDocUpdate(id);
      return reply.send({ update: Buffer.from(update).toString("base64") });
    },
  );

  /**
   * Appends one incremental Yjs update to `project_doc_updates` (never
   * rewrites the document — see `docStorage.ts`'s `appendUpdate`).
   * Owner/editor only: a viewer's pushed updates are rejected with 403
   * rather than silently accepted. This isn't the hard, server-enforced
   * read-only boundary PLAN.md §9's Auth verification eventually requires
   * ("a viewer's WebSocket is genuinely read-only") — there's no realtime
   * transport yet for that to apply to (Job 020) — but it's a cheap,
   * correct check to add now rather than leaving the door open: nothing
   * about this job's scope requires *not* checking it.
   */
  fastify.post<{ Params: { id: string }; Body: { update?: string } }>(
    "/api/projects/:id/doc/updates",
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
      if (!canEdit(role)) {
        return reply.code(403).send({ error: "forbidden", detail: "viewer cannot push document updates" });
      }

      const raw = request.body?.update;
      if (typeof raw !== "string" || raw.length === 0) {
        return reply.code(400).send({ error: "invalid_update" });
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(raw, "base64");
      } catch {
        return reply.code(400).send({ error: "invalid_update" });
      }
      if (bytes.length === 0) {
        return reply.code(400).send({ error: "invalid_update" });
      }

      await appendUpdate(id, bytes, user.id);
      return reply.code(204).send();
    },
  );
};
