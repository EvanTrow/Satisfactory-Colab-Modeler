// Job 022: thin fetch wrappers around `apps/api`'s member-management
// (`memberRoutes.ts`, Job 020) and invite (`inviteRoutes.ts`, this job)
// routes. Mirrors `../../api/projects.ts`'s conventions exactly
// (`credentials: "include"`, `ApiError` on a non-2xx response) — kept as
// its own module rather than folded into `api/projects.ts` since sharing is
// a distinct enough concern with its own multi-route surface, same
// reasoning `persistence/docApi.ts` already used for version history.
import { ApiError, type ProjectRole } from "../api/projects";

async function parseErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Members (Job 020's memberRoutes.ts)
// ---------------------------------------------------------------------------

export interface ProjectMemberInfo {
  userId: string;
  username: string;
  role: ProjectRole;
}

export function listProjectMembers(projectId: string): Promise<ProjectMemberInfo[]> {
  return request<ProjectMemberInfo[]>(`/api/projects/${projectId}/members`);
}

export function updateProjectMemberRole(
  projectId: string,
  userId: string,
  role: "editor" | "viewer",
): Promise<void> {
  return request<void>(`/api/projects/${projectId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function removeProjectMember(projectId: string, userId: string): Promise<void> {
  return request<void>(`/api/projects/${projectId}/members/${userId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Invites (this job's inviteRoutes.ts)
// ---------------------------------------------------------------------------

export type InviteRole = "editor" | "viewer";

export interface ProjectInviteInfo {
  id: string;
  role: InviteRole;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  createdBy: string;
}

/** Only present in `createInvite`'s own response — never returned by the list route. */
export interface CreatedProjectInvite extends ProjectInviteInfo {
  token: string;
}

export interface CreateInviteOptions {
  role: InviteRole;
  /** ISO string, or omitted for no expiry. */
  expiresAt?: string;
  maxUses?: number;
}

export function createProjectInvite(projectId: string, options: CreateInviteOptions): Promise<CreatedProjectInvite> {
  return request<CreatedProjectInvite>(`/api/projects/${projectId}/invites`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export function listProjectInvites(projectId: string): Promise<ProjectInviteInfo[]> {
  return request<ProjectInviteInfo[]>(`/api/projects/${projectId}/invites`);
}

export function revokeProjectInvite(projectId: string, inviteId: string): Promise<void> {
  return request<void>(`/api/projects/${projectId}/invites/${inviteId}`, { method: "DELETE" });
}

/** Builds the shareable link for a freshly created invite's raw token — same-origin, since the app is served same-origin per PLAN.md's deployment decision (matches `realtimeTicket.ts`'s same reasoning for the WS URL). */
export function buildInviteLink(token: string): string {
  return `${window.location.origin}/i/${token}`;
}

export type InvitePreview =
  | { valid: true; projectId: string; projectTitle: string; role: InviteRole }
  | { valid: false; reason: "not_found" | "expired" | "exhausted" };

/** Public preview — no auth required, used by the redeem page before the user is necessarily logged in. */
export function previewInvite(token: string): Promise<InvitePreview> {
  return request<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`);
}

export interface RedeemInviteResult {
  projectId: string;
  role: InviteRole;
  alreadyMember: boolean;
}

/** Redeems an invite for the current (authenticated) user. */
export function redeemInvite(token: string): Promise<RedeemInviteResult> {
  return request<RedeemInviteResult>(`/api/invites/${encodeURIComponent(token)}/redeem`, { method: "POST" });
}
