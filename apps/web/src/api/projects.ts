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
 * `POST /api/projects/:id/duplicate`'s response shape. Through Job 006-014
 * this carried a `metadataOnly: true` flag (there was no CRDT document to
 * duplicate yet — `project_doc_state` didn't exist), which `ProjectsPage.tsx`
 * surfaced as a dismissible notice. Job 015 added `project_doc_state` and
 * wired real doc duplication (`apps/api/src/projects/store.ts`'s
 * `duplicateProject` now also calls `docStorage.ts`'s `duplicateDocState`),
 * so the flag and the notice were both removed rather than kept around
 * always-`false` — a duplicate is a real, full duplicate now.
 */
export type DuplicatedProject = ProjectSummary;

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
