// Thin fetch wrapper around apps/api's version-history routes
// (apps/api/src/projects/docRoutes.ts). Mirrors ../../api/projects.ts's own
// conventions (credentials: "include" for the same-origin session cookie,
// ApiError on a non-2xx response) rather than introducing a second request
// helper — kept as a separate module (not added to api/projects.ts) since
// these routes deal partly in bytes/base64, not just the camelCase JSON
// shape every other project route uses.
//
// Job 020: the live-sync load/push wrappers that used to live here
// (`fetchProjectDoc`/`pushProjectDocUpdate`, calling `GET`/`POST
// /api/projects/:id/doc`) were removed — `useProjectDocument.ts` now gets
// both via `@hocuspocus/provider`'s WebSocket sync instead of REST. The
// *server* routes they called are deliberately left in place and untouched
// (see `apps/api/src/projects/docRoutes.ts`'s own header comment) — this
// job's own scope note left that decision explicit: "NOT necessarily
// obsolete... decide whether [the push route] stays as a fallback/dead code
// or gets removed." Decision: keep the server routes (still fully tested,
// zero cost to leave working, and a plausible fallback/debugging path or a
// future non-realtime consumer), remove only the now-genuinely-unused
// client-side wrappers around them.
import { ApiError } from "../../api/projects";

async function parseErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Wire shape of `apps/api`'s `docRoutes.ts` `SerializedVersion` — a `project_versions` row without its `ydoc` bytes. */
export interface ProjectVersionInfo {
  id: string;
  label: string | null;
  kind: "auto" | "manual" | "import" | "pre_restore";
  createdBy: string | null;
  createdAt: string;
}

/** Lists a project's versions, newest first (Job 016's version-history list). */
export async function listProjectVersions(projectId: string): Promise<ProjectVersionInfo[]> {
  const res = await fetch(`/api/projects/${projectId}/versions`, { credentials: "include" });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  return (await res.json()) as ProjectVersionInfo[];
}

/** Creates a `kind: 'manual'` snapshot of the project's current state — Job 016's "Save version" button. `label` is trimmed/optional server-side. */
export async function saveProjectVersion(projectId: string, label?: string): Promise<ProjectVersionInfo> {
  const res = await fetch(`/api/projects/${projectId}/versions`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(label ? { label } : {}),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  return (await res.json()) as ProjectVersionInfo;
}

/** Result of a successful restore — see `apps/api`'s `docRoutes.ts` restore route. */
export interface RestoreVersionResult {
  restoredVersionId: string;
  /** `null` when the caller opted out of the pre-restore safety snapshot. */
  preRestoreVersion: ProjectVersionInfo | null;
}

/**
 * Restores `versionId` as the project's new current document state. Only
 * changes server-side state — the caller is responsible for making the live
 * local doc reflect it afterward (`useProjectDocument.ts`'s
 * `reloadAfterRestore`), since a restore is a wholesale replace, not
 * something a `Y.applyUpdate` merge into the existing local doc can express
 * correctly (see that function's own doc comment).
 *
 * `createPreRestoreVersion` (default `true`) controls whether the server
 * takes a safety snapshot of current state before overwriting it — the
 * version-history UI asks the user each restore rather than forcing this
 * unconditionally.
 */
export async function restoreProjectVersion(
  projectId: string,
  versionId: string,
  createPreRestoreVersion = true,
): Promise<RestoreVersionResult> {
  const res = await fetch(`/api/projects/${projectId}/versions/${versionId}/restore`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ createPreRestoreVersion }),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  return (await res.json()) as RestoreVersionResult;
}

/** Deletes one version from a project's history — Job 016 follow-up's "add a way to delete versions." Never touches the project's current live document state. */
export async function deleteProjectVersion(projectId: string, versionId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/versions/${versionId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
}
