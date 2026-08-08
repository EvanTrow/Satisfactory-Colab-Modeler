// Job 022: the real sharing UI — "the piece deliberately deferred from Job
// 006," extending Job 020's owner-only REST routes with an actual UI.
// Styled as a `VersionPanel.tsx`-style toolbar dropdown (same "button that
// opens an absolutely-positioned panel, closed by an invisible full-screen
// backdrop" shape) rather than a separate modal/route, so it lives right
// next to the other per-project controls in `CanvasView.tsx`'s header.
//
// Two sections:
//   - Invite links: owner-only creation (role + optional expiry/max-uses),
//     a copy-to-clipboard button for the freshly minted link, and a list of
//     currently-active invites with a revoke button. Since `invites.ts`
//     (API-side) only ever hands back a raw token at creation time — the
//     server stores nothing but its hash, same as a session token, so it's
//     not retrievable later — re-copying an *existing* link only works for
//     invites created earlier in this same browser tab: their tokens are
//     cached client-side in `sessionStorage`, keyed by invite id (see
//     `loadCachedTokens`/`saveCachedTokens` below). An invite with no cached
//     token (created in another tab/session, or before this cache existed)
//     shows no Copy button — there's nothing to recover, only Revoke.
//   - Members: visible to every role (`memberRoutes.ts`'s own "any member
//     can view the list" rule), but role-change/remove controls only render
//     for the owner — the server enforces this regardless, this is just UX.
import { Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useFocusTrap } from "../a11y";
import type { ProjectRole } from "../api/projects";
import { ConfirmDialog, useConfirmDialog } from "../ui";
import {
  buildInviteLink,
  createProjectInvite,
  listProjectInvites,
  listProjectMembers,
  removeProjectMember,
  revokeProjectInvite,
  updateProjectMemberRole,
  type InviteRole,
  type ProjectInviteInfo,
  type ProjectMemberInfo,
} from "./api";

export interface SharingPanelProps {
  projectId: string;
  /** The current user's own role — gates which controls render (server-enforced regardless, see this file's header comment). */
  role: ProjectRole;
  /** The current user's id — so "remove" never renders next to your own row (mirrors `memberRoutes.ts`'s "cannot remove/change the owner" rule; a non-owner member removing *themselves* isn't offered here either, kept simple — leaving a project isn't this job's scope). */
  currentUserId: string;
}

type MembersState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; members: ProjectMemberInfo[] };

type InvitesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; invites: ProjectInviteInfo[] };

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

function formatExpiry(iso: string | null): string {
  if (!iso) return "never expires";
  const date = new Date(iso);
  return date <= new Date() ? "expired" : `expires ${date.toLocaleString()}`;
}

function formatUses(invite: ProjectInviteInfo): string {
  return invite.maxUses === null ? `${invite.uses} use${invite.uses === 1 ? "" : "s"}` : `${invite.uses}/${invite.maxUses} uses`;
}

/** sessionStorage key for a project's cached invite tokens — per-tab, cleared on tab close (matches the "only recoverable in the session that created it" scope of the cache itself). */
function tokenCacheKey(projectId: string): string {
  return `scm-invite-tokens:${projectId}`;
}

function loadCachedTokens(projectId: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(tokenCacheKey(projectId));
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    // Storage can throw in locked-down/private-browsing contexts, or hold
    // malformed JSON — either way, falling back to "no cached links" just
    // means Copy buttons don't show up, not a crash.
    return {};
  }
}

function saveCachedTokens(projectId: string, tokens: Record<string, string>): void {
  try {
    window.sessionStorage.setItem(tokenCacheKey(projectId), JSON.stringify(tokens));
  } catch {
    // Best-effort persistence — see loadCachedTokens.
  }
}

export function SharingPanel({ projectId, role, currentUserId }: SharingPanelProps) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MembersState>({ status: "idle" });
  const [invites, setInvites] = useState<InvitesState>({ status: "idle" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [newInviteRole, setNewInviteRole] = useState<InviteRole>("editor");
  const [newInviteExpiryDays, setNewInviteExpiryDays] = useState<string>("");
  const [newInviteMaxUses, setNewInviteMaxUses] = useState<string>("");
  const [creating, setCreating] = useState(false);
  // Invite id -> raw token, for invites created in this browser tab (see this
  // file's header comment). `justCreatedId` picks out the one to show in the
  // highlighted "just created" box; the rest only get a Copy button in the list.
  const [knownTokens, setKnownTokens] = useState<Record<string, string>>({});
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);

  const isOwner = role === "owner";

  // Job 029: focus trap while the panel is open — see
  // `a11y/useFocusTrap.ts`'s header comment; same shape as
  // `SettingsMenu`/`VersionPanel`.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open, { onClose: () => setOpen(false) });
  const { requestConfirm, dialogProps: confirmDialogProps } = useConfirmDialog();

  async function refreshMembers() {
    setMembers({ status: "loading" });
    try {
      const list = await listProjectMembers(projectId);
      setMembers({ status: "loaded", members: list });
    } catch (err) {
      setMembers({ status: "error", message: describeError(err) });
    }
  }

  async function refreshInvites() {
    if (!isOwner) return;
    setInvites({ status: "loading" });
    try {
      const list = await listProjectInvites(projectId);
      setInvites({ status: "loaded", invites: list });
      // Prune cached tokens for invites that no longer exist (revoked —
      // possibly from another tab — or expired off the list) so the cache
      // doesn't grow unboundedly and never offers a Copy button for a dead invite.
      setKnownTokens((current) => {
        const validIds = new Set(list.map((invite) => invite.id));
        const next: Record<string, string> = {};
        let changed = false;
        for (const [id, token] of Object.entries(current)) {
          if (validIds.has(id)) {
            next[id] = token;
          } else {
            changed = true;
          }
        }
        if (!changed) return current;
        saveCachedTokens(projectId, next);
        return next;
      });
    } catch (err) {
      setInvites({ status: "error", message: describeError(err) });
    }
  }

  useEffect(() => {
    if (!open) return;
    setActionError(null);
    setJustCreatedId(null);
    setCopiedInviteId(null);
    setKnownTokens(loadCachedTokens(projectId));
    void refreshMembers();
    void refreshInvites();
    // refreshMembers/refreshInvites close over stable props (projectId/isOwner) — re-running on `open` alone matches VersionPanel.tsx's identical pattern.
  }, [open]);

  async function handleCreateInvite() {
    setCreating(true);
    setActionError(null);
    try {
      const options: Parameters<typeof createProjectInvite>[1] = { role: newInviteRole };
      const days = Number(newInviteExpiryDays);
      if (newInviteExpiryDays.trim() && Number.isFinite(days) && days > 0) {
        options.expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      }
      const maxUses = Number(newInviteMaxUses);
      if (newInviteMaxUses.trim() && Number.isInteger(maxUses) && maxUses > 0) {
        options.maxUses = maxUses;
      }
      const created = await createProjectInvite(projectId, options);
      setKnownTokens((current) => {
        const next = { ...current, [created.id]: created.token };
        saveCachedTokens(projectId, next);
        return next;
      });
      setJustCreatedId(created.id);
      setCopiedInviteId(null);
      setNewInviteExpiryDays("");
      setNewInviteMaxUses("");
      await refreshInvites();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopyInviteLink(inviteId: string) {
    const token = knownTokens[inviteId];
    if (!token) return;
    try {
      await navigator.clipboard.writeText(buildInviteLink(token));
      setCopiedInviteId(inviteId);
    } catch {
      // Clipboard permission denied or unavailable — the link is still
      // visible/selectable as plain text in the input below, so this isn't
      // a dead end for the user.
    }
  }

  async function handleRevokeInvite(invite: ProjectInviteInfo) {
    const confirmed = await requestConfirm({
      message: "Revoke this invite link? It can no longer be used to join once revoked.",
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!confirmed) return;
    setBusyKey(`invite:${invite.id}`);
    setActionError(null);
    try {
      await revokeProjectInvite(projectId, invite.id);
      setKnownTokens((current) => {
        if (!(invite.id in current)) return current;
        const next = { ...current };
        delete next[invite.id];
        saveCachedTokens(projectId, next);
        return next;
      });
      setJustCreatedId((current) => (current === invite.id ? null : current));
      await refreshInvites();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRoleChange(member: ProjectMemberInfo, nextRole: "editor" | "viewer") {
    setBusyKey(`member:${member.userId}`);
    setActionError(null);
    try {
      await updateProjectMemberRole(projectId, member.userId, nextRole);
      await refreshMembers();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRemoveMember(member: ProjectMemberInfo) {
    const confirmed = await requestConfirm({
      message: `Remove ${member.username} from this project?`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!confirmed) return;
    setBusyKey(`member:${member.userId}`);
    setActionError(null);
    try {
      await removeProjectMember(projectId, member.userId);
      await refreshMembers();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        title="Share this project"
        aria-label="Share this project"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="nodrag inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
      >
        <Share2 className="h-3.5 w-3.5" aria-hidden />
        Share
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Share this project"
            className="absolute right-0 top-full z-50 mt-1 w-96 rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-2 shadow-[var(--shadow-modal)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {actionError && (
              <p className="mb-2 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-2 py-1 text-xs text-[var(--danger)]">
                {actionError}
              </p>
            )}

            {isOwner && (
              <div className="mb-3">
                <p className="mb-1 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Invite link</p>

                {justCreatedId && knownTokens[justCreatedId] && (
                  <div className="mb-2 flex items-center gap-1 rounded-md border border-[var(--outpost-border)] bg-[var(--outpost-soft)] px-2 py-1.5">
                    <input
                      readOnly
                      value={buildInviteLink(knownTokens[justCreatedId])}
                      onFocus={(event) => event.currentTarget.select()}
                      className="min-w-0 flex-1 bg-transparent text-xs text-[var(--outpost)] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleCopyInviteLink(justCreatedId)}
                      className="shrink-0 rounded-md bg-[var(--accent)] px-2 py-1 text-[11px] font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                    >
                      {copiedInviteId === justCreatedId ? "Copied!" : "Copy"}
                    </button>
                  </div>
                )}

                <div className="mb-2 flex flex-wrap items-center gap-1 px-1">
                  <select
                    value={newInviteRole}
                    onChange={(event) => setNewInviteRole(event.target.value as InviteRole)}
                    className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <input
                    type="number"
                    min={1}
                    placeholder="Expires (days)"
                    value={newInviteExpiryDays}
                    onChange={(event) => setNewInviteExpiryDays(event.target.value)}
                    className="w-28 rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  <input
                    type="number"
                    min={1}
                    placeholder="Max uses"
                    value={newInviteMaxUses}
                    onChange={(event) => setNewInviteMaxUses(event.target.value)}
                    className="w-24 rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCreateInvite()}
                    disabled={creating}
                    className="shrink-0 rounded-md bg-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                  >
                    {creating ? "Creating…" : "Create link"}
                  </button>
                </div>

                <div className="max-h-32 overflow-y-auto">
                  {invites.status === "loading" && <p className="px-1 py-1 text-xs text-[var(--text-muted)]">Loading…</p>}
                  {invites.status === "error" && <p className="px-1 py-1 text-xs text-[var(--danger)]">{invites.message}</p>}
                  {invites.status === "loaded" && invites.invites.length === 0 && (
                    <p className="px-1 py-1 text-xs text-[var(--text-muted)]">No active invite links.</p>
                  )}
                  {invites.status === "loaded" &&
                    invites.invites.map((invite) => {
                      const token = knownTokens[invite.id];
                      return (
                        <div
                          key={invite.id}
                          className="flex items-center justify-between gap-2 rounded-md px-1 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                        >
                          <div className="min-w-0">
                            <span className="text-[var(--text-primary)]">{invite.role}</span> ·{" "}
                            {formatUses(invite)} · {formatExpiry(invite.expiresAt)}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {token && (
                              <button
                                type="button"
                                onClick={() => void handleCopyInviteLink(invite.id)}
                                title="Copy this invite link again"
                                className="rounded-md border border-[var(--border-default)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                              >
                                {copiedInviteId === invite.id ? "Copied!" : "Copy"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleRevokeInvite(invite)}
                              disabled={busyKey === `invite:${invite.id}`}
                              className="rounded-md border border-[var(--border-default)] px-2 py-0.5 text-[11px] text-[var(--danger)] hover:border-[var(--danger)] disabled:opacity-50"
                            >
                              Revoke
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            <div>
              <p className="mb-1 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Members</p>
              <div className="max-h-52 overflow-y-auto">
                {members.status === "loading" && <p className="px-1 py-1 text-xs text-[var(--text-muted)]">Loading…</p>}
                {members.status === "error" && <p className="px-1 py-1 text-xs text-[var(--danger)]">{members.message}</p>}
                {members.status === "loaded" &&
                  members.members.map((member) => {
                    const isSelf = member.userId === currentUserId;
                    const isMemberOwner = member.role === "owner";
                    const canManage = isOwner && !isMemberOwner;
                    return (
                      <div
                        key={member.userId}
                        className="flex items-center justify-between gap-2 rounded-md px-1 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                      >
                        <span className="min-w-0 truncate text-[var(--text-primary)]">
                          {member.username}
                          {isSelf ? " (you)" : ""}
                        </span>
                        {canManage ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <select
                              value={member.role}
                              onChange={(event) => void handleRoleChange(member, event.target.value as "editor" | "viewer")}
                              disabled={busyKey === `member:${member.userId}`}
                              className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1 py-0.5 text-[11px] text-[var(--text-primary)] disabled:opacity-50"
                            >
                              <option value="editor">Editor</option>
                              <option value="viewer">Viewer</option>
                            </select>
                            <button
                              type="button"
                              onClick={() => void handleRemoveMember(member)}
                              disabled={busyKey === `member:${member.userId}`}
                              className="rounded-md border border-[var(--border-default)] px-1.5 py-0.5 text-[11px] text-[var(--danger)] hover:border-[var(--danger)] disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </div>
                        ) : (
                          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{member.role}</span>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        </>
      )}
      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
