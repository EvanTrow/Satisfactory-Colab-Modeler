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

import {
  appendUpdate,
  createProjectVersion,
  deleteProjectVersion,
  listProjectVersions,
  loadProjectDocUpdate,
  restoreProjectVersion,
  type ProjectVersionSummary,
} from "@scm/doc-storage";

import { canEdit, resolveRole } from "./roles.js";
import { findActiveProjectById } from "./store.js";

/**
 * Wire shape for `ProjectVersionSummary` — camelCase JSON, matching every
 * other route's `SerializedProject` convention. `createdAt` is left typed as
 * `ProjectVersionSummary["createdAt"]` (a real `Date` at runtime) rather than
 * asserted as `string` and manually `.toISOString()`'d — same as
 * `routes.ts`'s `SerializedProject.createdAt: Project["created_at"]`.
 * Fastify's JSON serialization turns the actual `Date` instance into an ISO
 * string on the wire regardless of what TypeScript calls its type.
 */
interface SerializedVersion {
  id: string;
  label: string | null;
  kind: ProjectVersionSummary["kind"];
  createdBy: string | null;
  createdAt: ProjectVersionSummary["createdAt"];
}

function serializeVersion(version: ProjectVersionSummary): SerializedVersion {
  return {
    id: version.id,
    label: version.label,
    kind: version.kind,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
  };
}

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

  /**
   * Lists a project's versions, newest first — Job 016's "list a project's
   * versions (timestamp, label, kind)." Any project member (owner/editor/
   * viewer) can view the list, same read-only access level as `GET .../doc`.
   */
  fastify.get<{ Params: { id: string } }>(
    "/api/projects/:id/versions",
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

      const versions = await listProjectVersions(id);
      return reply.send(versions.map(serializeVersion));
    },
  );

  /**
   * Creates a `kind: 'manual'` version snapshot of the project's current
   * state — Job 016's "Save version" button. Owner/editor only, same
   * write-gate as pushing a doc update (a viewer can't create a durable
   * checkpoint of state they can't change anyway).
   */
  fastify.post<{ Params: { id: string }; Body: { label?: string } }>(
    "/api/projects/:id/versions",
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
        return reply.code(403).send({ error: "forbidden", detail: "viewer cannot save a version" });
      }

      const rawLabel = request.body?.label;
      const label = typeof rawLabel === "string" && rawLabel.trim().length > 0 ? rawLabel.trim() : null;

      const version = await createProjectVersion(id, { kind: "manual", label, createdBy: user.id });
      return reply.code(201).send(serializeVersion(version));
    },
  );

  /**
   * Restores `versionId` as the project's new current document state —
   * Job 016's basic restore flow. Owner/editor only (same gate as any other
   * write). See `docStorage.ts`'s `restoreProjectVersion` for the
   * "wholesale replace, not merge" mechanism and the `pre_restore` safety
   * snapshot it takes first. Responds with the safety snapshot's metadata so
   * the client can show "a pre-restore checkpoint was saved" without a
   * second round-trip.
   *
   * `createPreRestoreVersion` (body, default `true`) lets the client opt out
   * of that safety snapshot — the version-history UI asks the user each
   * restore, rather than forcing it unconditionally. `preRestoreVersion` in
   * the response is `null` when it was skipped.
   */
  fastify.post<{ Params: { id: string; versionId: string }; Body: { createPreRestoreVersion?: boolean } }>(
    "/api/projects/:id/versions/:versionId/restore",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const { id, versionId } = request.params;

      const role = await resolveRole(id, user.id);
      if (role === null) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const project = await findActiveProjectById(id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      if (!canEdit(role)) {
        return reply.code(403).send({ error: "forbidden", detail: "viewer cannot restore a version" });
      }

      const createPreRestoreVersion = request.body?.createPreRestoreVersion !== false;
      const result = await restoreProjectVersion(id, versionId, user.id, { createPreRestoreVersion });
      if (result === null) {
        return reply.code(404).send({ error: "version_not_found" });
      }

      return reply.send({
        restoredVersionId: result.restoredVersionId,
        preRestoreVersion: result.preRestoreVersion ? serializeVersion(result.preRestoreVersion) : null,
      });
    },
  );

  /**
   * Deletes one version from a project's history. Owner/editor only, same
   * write-gate as saving/restoring a version. Purely a version-history
   * housekeeping op — never touches the project's current live document
   * state (`docStorage.ts`'s `deleteProjectVersion`).
   */
  fastify.delete<{ Params: { id: string; versionId: string } }>(
    "/api/projects/:id/versions/:versionId",
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const { id, versionId } = request.params;

      const role = await resolveRole(id, user.id);
      if (role === null) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const project = await findActiveProjectById(id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      if (!canEdit(role)) {
        return reply.code(403).send({ error: "forbidden", detail: "viewer cannot delete a version" });
      }

      const deleted = await deleteProjectVersion(id, versionId);
      if (!deleted) {
        return reply.code(404).send({ error: "version_not_found" });
      }

      return reply.code(204).send();
    },
  );
};
