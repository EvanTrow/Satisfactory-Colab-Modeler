// Thin fetch wrapper around apps/api's project routes
// (apps/api/src/projects/routes.ts). Mirrors that file's `SerializedProject`
// JSON shape exactly (camelCase, ISO date strings over the wire).

export type ProjectRole = "owner" | "editor" | "viewer";
export type ProjectVisibility = "private" | "link" | "public";

export interface ProjectSummary {
  id: string;
  shortId: string;
  ownerId: string;
  title: string;
  visibility: ProjectVisibility;
  gameDataVersion: string;
  createdAt: string;
  updatedAt: string;
  /** The current user's role on this project — drives which actions the UI offers. */
  role: ProjectRole;
}

/**
 * `POST /api/projects/:id/duplicate`'s response also carries this flag —
 * duplication is project-metadata-only until Job 015 adds the CRDT
 * document tables (`project_doc_state`); see
 * `apps/api/src/projects/store.ts`'s `duplicateProject` doc comment for the
 * full explanation. `apps/web` surfaces this to the user (see
 * `ProjectsPage.tsx`) rather than silently implying a full copy happened.
 */
export interface DuplicatedProject extends ProjectSummary {
  metadataOnly: true;
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: "include",
    // Only set `content-type: application/json` when there's actually a
    // body: Fastify's default JSON body parser rejects a request that
    // *declares* a JSON content-type but sends an empty body
    // (`FST_ERR_CTP_EMPTY_JSON_BODY`) — hit in manual testing via
    // `duplicateProject`/`deleteProject`, which POST/DELETE with no body.
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });

  if (!res.ok) {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      // Non-JSON error body (e.g. a proxy/network failure) — leave undefined.
    }
    throw new ApiError(res.status, body);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export function listProjects(): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>("/api/projects");
}

export function createProject(title?: string): Promise<ProjectSummary> {
  return request<ProjectSummary>("/api/projects", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
}

export function renameProject(id: string, title: string): Promise<ProjectSummary> {
  return request<ProjectSummary>(`/api/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export function duplicateProject(id: string): Promise<DuplicatedProject> {
  return request<DuplicatedProject>(`/api/projects/${id}/duplicate`, { method: "POST" });
}

export function deleteProject(id: string): Promise<void> {
  return request<void>(`/api/projects/${id}`, { method: "DELETE" });
}
