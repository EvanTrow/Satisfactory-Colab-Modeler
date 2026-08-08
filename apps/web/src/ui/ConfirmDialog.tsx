// A styled stand-in for `window.confirm`, matching this app's other modal
// chrome (`RecipeChooser.tsx`/`ProjectsPage.tsx`'s "+ New Project" dialog:
// a `fixed inset-0` backdrop, centered `surface-panel` box, focus trap).
// Native `confirm()` can't be themed, blocks the whole tab, and reads as a
// jarring OS-chrome popup inside an otherwise fully custom UI — this is a
// drop-in replacement via `useConfirmDialog`'s promise-returning
// `requestConfirm`, so call sites keep their `if (!(await requestConfirm(...)))
// return;` early-return shape.
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { useFocusTrap } from "../a11y";

export interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as a destructive action (delete/revoke/remove) — reuses the same `danger`/`danger-soft` pair already audited in `a11y/contrastAudit.ts`. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation("app");
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, open, { onClose: onCancel, initialFocusRef: confirmButtonRef });

  if (!open) return null;

  return (
    // z-[70]: above every other panel's own z-40/z-50 backdrop+box, since a
    // confirm can be triggered from inside an already-open dropdown panel
    // (e.g. VersionPanel's delete, SharingPanel's revoke/remove).
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title ?? t("confirm.defaultTitle")}
        className="w-full max-w-sm rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-4 shadow-[var(--shadow-modal)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {title && <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">{title}</h3>}
        <p className="mb-4 text-sm text-[var(--text-secondary)]">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            {cancelLabel ?? t("confirm.cancel")}
          </button>
          <button
            type="button"
            ref={confirmButtonRef}
            onClick={onConfirm}
            className={
              danger
                ? "rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-1.5 text-sm font-medium text-[var(--danger)] hover:brightness-110"
                : "rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
            }
          >
            {confirmLabel ?? t("confirm.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
