// Job 022: the invite-redemption screen — reached via a share link
// (`/i/:token`, per `api.ts`'s `buildInviteLink`). Shows the invite's public
// preview (project title, role, validity — `GET /api/invites/:token`, no
// auth required) so a visitor knows what they're accepting before doing
// anything, then either prompts login (anonymous visitor) or redeems
// outright (already logged in).
//
// This app has no router (see `App.tsx`'s own `View` comment — plain React
// state + manual `pathname` parsing, not React Router), so `App.tsx` is
// what detects the `/i/:token` path and decides when to mount this
// component; this file itself is router-agnostic (just props in, callback
// out).
import { useEffect, useState } from "react";

import { ApiError } from "../api/projects";
import { previewInvite, redeemInvite, type InvitePreview } from "./api";

export interface InviteRedeemPageProps {
  token: string;
  /** `null` when not logged in. */
  isAuthenticated: boolean;
  /** Called with the redeemed project's id once redemption succeeds — the caller (`App.tsx`) opens that project's canvas. */
  onRedeemed: (projectId: string) => void;
  /** "Never mind" / dismiss — back to the normal project list. */
  onDismiss: () => void;
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "invalid"; reason: string }
  | { status: "ready"; preview: Extract<InvitePreview, { valid: true }> }
  | { status: "redeeming"; preview: Extract<InvitePreview, { valid: true }> }
  | { status: "redeem-error"; preview: Extract<InvitePreview, { valid: true }>; message: string };

const REASON_LABEL: Record<string, string> = {
  not_found: "This invite link doesn't exist (or has already been revoked).",
  expired: "This invite link has expired.",
  exhausted: "This invite link has already been used the maximum number of times.",
};

export function InviteRedeemPage({ token, isAuthenticated, onRedeemed, onDismiss }: InviteRedeemPageProps) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    previewInvite(token)
      .then((preview) => {
        if (cancelled) return;
        setState(preview.valid ? { status: "ready", preview } : { status: "invalid", reason: preview.reason });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load this invite" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleAccept() {
    if (state.status !== "ready") return;
    const preview = state.preview;
    setState({ status: "redeeming", preview });
    try {
      const result = await redeemInvite(token);
      onRedeemed(result.projectId);
    } catch (err) {
      const message =
        err instanceof ApiError && typeof err.body === "object" && err.body !== null && "error" in err.body
          ? String((err.body as { error: unknown }).error)
          : err instanceof Error
            ? err.message
            : "Failed to accept this invite";
      setState({ status: "redeem-error", preview, message });
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-6 shadow-[var(--shadow-modal)]">
        {state.status === "loading" && <p className="text-[var(--text-muted)]">Loading invite…</p>}

        {state.status === "error" && <p className="text-[var(--danger)]">{state.message}</p>}

        {state.status === "invalid" && (
          <p className="text-[var(--danger)]">{REASON_LABEL[state.reason] ?? "This invite link is no longer valid."}</p>
        )}

        {(state.status === "ready" || state.status === "redeeming" || state.status === "redeem-error") && (
          <>
            <h2 className="mb-1 text-lg font-semibold tracking-tight">You've been invited</h2>
            <p className="mb-4 text-sm text-[var(--text-secondary)]">
              Join <strong className="text-[var(--text-primary)]">{state.preview.projectTitle}</strong> as a{" "}
              <strong className="text-[var(--text-primary)]">{state.preview.role}</strong>.
            </p>

            {!isAuthenticated && (
              <p className="mb-4 text-xs text-[var(--text-muted)]">Log in with Discord to accept this invite.</p>
            )}

            {state.status === "redeem-error" && (
              <p className="mb-3 rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-2 py-1 text-xs text-[var(--danger)]">
                {state.message}
              </p>
            )}

            <div className="flex justify-center gap-2">
              {isAuthenticated ? (
                <button
                  type="button"
                  onClick={() => void handleAccept()}
                  disabled={state.status === "redeeming"}
                  className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {state.status === "redeeming" ? "Joining…" : "Accept invite"}
                </button>
              ) : (
                <a
                  href="/auth/discord/login"
                  className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
                >
                  Log in with Discord
                </a>
              )}
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-md border border-[var(--border-default)] px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Not now
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
