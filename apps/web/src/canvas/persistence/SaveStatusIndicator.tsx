// Job 016: the real autosave-status indicator Job 015 left as a static
// placeholder string ("autosaves ~1.5s after your last edit (Job 016 adds a
// live indicator)"). Reflects `updateQueue.ts`'s `SaveStatus` (sourced via
// `useProjectDocument`'s `saveStatus`), not a hardcoded claim — see that
// file's own doc comment for exactly what each state means and how it's
// computed.
import type { ProjectRole } from "../../api/projects";
import type { SaveStatus } from "./updateQueue";

export interface SaveStatusIndicatorProps {
  status: SaveStatus;
  /** A viewer's local edits are never pushed at all (see `useProjectDocument.ts`'s header comment) — showing "Saved" for a viewer would be misleading, so this renders a distinct "View only" label instead. */
  role: ProjectRole;
}

const DOT_CLASS: Record<SaveStatus, string> = {
  saved: "bg-[var(--success)]",
  saving: "bg-[var(--accent)] animate-pulse",
  offline: "bg-[var(--danger)] animate-pulse",
};

const LABEL: Record<SaveStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  offline: "Offline — reconnecting",
};

export function SaveStatusIndicator({ status, role }: SaveStatusIndicatorProps) {
  if (role === "viewer") {
    return <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">View only</span>;
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
      title={`Autosave: ${LABEL[status]}`}
      // Announces state changes to assistive tech without stealing focus —
      // this is exactly the kind of ambient, low-priority status update
      // `aria-live="polite"` is for.
      aria-live="polite"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[status]}`} aria-hidden />
      {LABEL[status]}
    </span>
  );
}
