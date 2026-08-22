// The "Delete Outpost" right-click menu item now opens this instead of
// deleting immediately — a real three-way choice (Cancel / Keep Contents /
// Delete Everything) that `ui/ConfirmDialog.tsx`'s binary confirm/cancel API
// doesn't fit, so this is its own small dialog rather than a variant of
// that one. Chrome (backdrop, centered panel, focus trap) intentionally
// matches `ConfirmDialog.tsx` exactly for visual consistency.
import { useRef } from "react";

import { useFocusTrap } from "../../a11y";

export interface DeleteOutpostDialogProps {
  open: boolean;
  /** `"outpost"` or `"blueprint"` — only used to word the message. */
  containerKind: "outpost" | "blueprint";
  containerTitle: string;
  onKeepContents: () => void;
  onDeleteEverything: () => void;
  onCancel: () => void;
}

export function DeleteOutpostDialog({
  open,
  containerKind,
  containerTitle,
  onKeepContents,
  onDeleteEverything,
  onCancel,
}: DeleteOutpostDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, open, { onClose: onCancel, initialFocusRef: keepButtonRef });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={`Delete ${containerKind}`}
        className="w-full max-w-sm rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-4 shadow-[var(--shadow-modal)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">
          Delete {containerTitle || containerKind}?
        </h3>
        <div className="mb-4 text-sm text-[var(--text-secondary)]">
          Keep Contents moves everything inside up into the parent container. Delete Everything permanently removes
          the {containerKind} and everything inside it, including its own connections.
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            ref={keepButtonRef}
            onClick={onKeepContents}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
          >
            Keep Contents
          </button>
          <button
            type="button"
            onClick={onDeleteEverything}
            className="rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-1.5 text-sm font-medium text-[var(--danger)] hover:brightness-110"
          >
            Delete Everything
          </button>
        </div>
      </div>
    </div>
  );
}
