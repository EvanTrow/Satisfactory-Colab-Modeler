import type { Project, ProjectMemberRole } from "@scm/db";
import { sql } from "kysely";

import { db } from "../db.js";
import { duplicateDocState } from "./docStorage.js";
import { generateShortId } from "./short-id.js";

/**
 * Mirrors `@scm/gamedata`'s `GAME_DATA_VERSION` constant
 * (`packages/gamedata/src/load.ts`) rather than importing it directly:
 * `apps/api`'s `tsconfig.json` uses `moduleResolution: NodeNext`, which
 * requires every relative import in every file reachable from the program
 * — including inside a dependency's own source, since `@scm/gamedata`'s
 * `package.json` points `main`/`types` straight at `src/index.ts` rather
 * than a built `dist/` — to carry an explicit `.js` extension.
 * `packages/gamedata`'s internal relative imports don't have those
 * extensions (it's typechecked under the base `moduleResolution: Bundler`,
 * which doesn't require them), so importing it from here fails
 * `apps/api`'s typecheck with `TS2835` on files this job didn't touch.
 * Duplicating the literal here avoids a cross-package fix outside this
 * job's scope; if `packages/gamedata`'s exports ever change, keep this in
 * sync (or, better, revisit by adding `.js` extensions to
 * `packages/gamedata/src/*.ts`'s internal imports and importing the real
 * constant instead — flagged in Job 006's Handoff notes for whoever's
 * touching gamedata next).
 */
const GAME_DATA_VERSION = "unversioned" as const;

/** Postgres unique_violation SQLSTATE — same constant as `auth/session.ts`. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

const DEFAULT_TITLE = "Untitled Factory";
const MAX_SHORT_ID_ATTEMPTS = 5;

/** A project row plus the requesting user's role on it — what the list/create/etc. endpoints return. */
export interface ProjectWithRole {
  project: Project;
  role: ProjectMemberRole;
}

/**
 * Creates a new project owned by `ownerId` and inserts the corresponding
 * `owner` row into `project_members` in the same transaction, so a project
 * never momentarily exists without an owner membership row (the row every
 * other query in this module relies on for visibility/role checks).
 *
 * `short_id` collisions are handled the same way `auth/session.ts` handles
 * session-token-hash collisions: catch the unique-violation and retry with
 * a freshly generated id, rather than assuming 8 random bytes can never
 * collide.
 */
export async function createProject(ownerId: string, title?: string): Promise<ProjectWithRole> {
  for (let attempt = 1; attempt <= MAX_SHORT_ID_ATTEMPTS; attempt++) {
    const shortId = generateShortId();
    try {
      const project = await db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto("projects")
          .values({
            short_id: shortId,
            owner_id: ownerId,
            title: title?.trim() || DEFAULT_TITLE,
            game_data_version: GAME_DATA_VERSION,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await trx
          .insertInto("project_members")
          .values({ project_id: inserted.id, user_id: ownerId, role: "owner" })
          .execute();

        return inserted;
      });

      return { project, role: "owner" };
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_SHORT_ID_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop always returns or throws.
  throw new Error("failed to create a project after retrying short_id generation");
}

/**
 * Lists every non-deleted project visible to `userId` — owned or shared —
 * via a single join on `project_members`, which is the source of truth for
 * visibility (every project, including ones the caller owns, has a
 * `project_members` row per `createProject` above, so there's no need for
 * a separate owner_id branch to cover owned projects).
 *
 * Filters `projects.deleted_at is null` so soft-deleted projects never
 * appear, matching the partial index on `projects(owner_id) where
 * deleted_at is null` in intent (this query doesn't filter by owner_id
 * directly since it also has to include shared projects, but it preserves
 * the same "only look at non-deleted rows" property that index exists for).
 */
export async function listProjectsForUser(userId: string): Promise<ProjectWithRole[]> {
  const rows = await db
    .selectFrom("projects")
    .innerJoin("project_members", "project_members.project_id", "projects.id")
    .where("project_members.user_id", "=", userId)
    .where("projects.deleted_at", "is", null)
    .selectAll("projects")
    .select("project_members.role as role")
    .orderBy("projects.updated_at", "desc")
    .execute();

  return rows.map(({ role, ...project }) => ({ project: project as Project, role }));
}

/** Fetches a non-deleted project by id, or `null` if it doesn't exist / is soft-deleted. */
export async function findActiveProjectById(projectId: string): Promise<Project | null> {
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  return project ?? null;
}

export interface RenameProjectInput {
  projectId: string;
  title: string;
}

/** Renames a project. Caller must already have verified the role via `roles.ts`. */
export async function renameProject({ projectId, title }: RenameProjectInput): Promise<Project> {
  return db
    .updateTable("projects")
    // `sql`now()`` (matching the migration's own `defaultTo(sql`now()`)`)
    // rather than a JS `new Date()` — there's no `updated_at` trigger in
    // the migration, so every mutating route has to bump it itself, and
    // letting Postgres stamp the time avoids clock skew between the app
    // server and the database.
    .set({ title, updated_at: sql`now()` })
    .where("id", "=", projectId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Soft-deletes a project by setting `deleted_at`. Caller must already have verified owner-only access. */
export async function softDeleteProject(projectId: string): Promise<Project> {
  return db
    .updateTable("projects")
    .set({ deleted_at: new Date() })
    .where("id", "=", projectId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Duplicates a project — its metadata row *and* its current canvas
 * document (`project_doc_state`/`project_doc_updates`, merged as of the
 * moment of duplication). New `id`/`short_id`, title suffixed "(copy)",
 * `owner_id` set to the duplicator (not necessarily the source project's
 * owner, since an editor/viewer is also allowed to duplicate — see
 * `roles.ts`'s `canDuplicate`).
 *
 * Was metadata-row-only through Job 006/014 (`project_doc_state` didn't
 * exist yet) — fixed by Job 015, which added that table and
 * `docStorage.ts`'s `duplicateDocState`. The doc copy runs *after* the
 * transaction that creates the new project row/membership commits, as a
 * separate step: `duplicateDocState` reads from `project_doc_state`/
 * `project_doc_updates` (outside this transaction) and writes a single new
 * `project_doc_state` row for the target project, so there's nothing to
 * gain by holding the projects-table transaction open across it, and doing
 * so would mean holding a row lock across a (comparatively) slow
 * Yjs-merge operation for no reason. If `duplicateDocState` throws, the new
 * project row still exists (with no doc content, same as the pre-Job-015
 * behavior for every project) — the caller (`routes.ts`) lets that surface
 * as a 500 rather than silently swallowing a failed doc copy.
 */
export async function duplicateProject(source: Project, duplicatorId: string): Promise<ProjectWithRole> {
  const copyTitle = `${source.title} (copy)`;

  for (let attempt = 1; attempt <= MAX_SHORT_ID_ATTEMPTS; attempt++) {
    const shortId = generateShortId();
    try {
      const project = await db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto("projects")
          .values({
            short_id: shortId,
            owner_id: duplicatorId,
            title: copyTitle,
            visibility: source.visibility,
            game_data_version: source.game_data_version,
            doc_settings: source.doc_settings,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await trx
          .insertInto("project_members")
          .values({ project_id: inserted.id, user_id: duplicatorId, role: "owner" })
          .execute();

        return inserted;
      });

      await duplicateDocState(source.id, project.id);

      return { project, role: "owner" };
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_SHORT_ID_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("failed to duplicate project after retrying short_id generation");
}
