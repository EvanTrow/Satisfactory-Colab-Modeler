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
