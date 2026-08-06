// Thin fetch wrapper around apps/api's doc load/push routes
// (apps/api/src/projects/docRoutes.ts). Mirrors ../../api/projects.ts's own
// conventions (credentials: "include" for the same-origin session cookie,
// ApiError on a non-2xx response) rather than introducing a second request
// helper — kept as a separate module (not added to api/projects.ts) since
// these two routes deal in bytes/base64, not the camelCase JSON shape every
// other project route uses.
import { ApiError } from "../../api/projects";
import { base64ToBytes, bytesToBase64 } from "./base64";

async function parseErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Fetches the project's current document state (snapshot + logs, merged
 * server-side) as raw Yjs update bytes, ready for `Y.applyUpdate(doc, bytes)`.
 */
export async function fetchProjectDoc(projectId: string): Promise<Uint8Array> {
  const res = await fetch(`/api/projects/${projectId}/doc`, { credentials: "include" });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  const body = (await res.json()) as { update: string };
  return base64ToBytes(body.update);
}

/**
 * Appends one incremental Yjs update. Server-side, this is always a plain
 * `INSERT` into `project_doc_updates` (`docStorage.ts`'s `appendUpdate`) —
 * never a rewrite of the whole document — so the caller should already have
 * merged whatever it's debounced into as few update blobs as reasonable
 * (see `updateQueue.ts`) before calling this, rather than calling it once
 * per tiny local change.
 */
export async function pushProjectDocUpdate(projectId: string, update: Uint8Array): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/doc/updates`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update: bytesToBase64(update) }),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
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
  preRestoreVersion: ProjectVersionInfo;
}

/**
 * Restores `versionId` as the project's new current document state. Only
 * changes server-side state — the caller is responsible for making the live
 * local doc reflect it afterward (`useProjectDocument.ts`'s
 * `reloadAfterRestore`), since a restore is a wholesale replace, not
 * something a `Y.applyUpdate` merge into the existing local doc can express
 * correctly (see that function's own doc comment).
 */
export async function restoreProjectVersion(projectId: string, versionId: string): Promise<RestoreVersionResult> {
  const res = await fetch(`/api/projects/${projectId}/versions/${versionId}/restore`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  return (await res.json()) as RestoreVersionResult;
}
