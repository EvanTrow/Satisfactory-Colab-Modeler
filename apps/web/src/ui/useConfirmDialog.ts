// Pairs with `ConfirmDialog.tsx` to give call sites a `window.confirm`-shaped
// API (`if (!(await requestConfirm({ message }))) return;`) backed by a real,
// themed modal instead of the native blocking dialog. One hook call per
// component that needs confirms; `dialogProps` spreads straight onto a single
// `<ConfirmDialog {...dialogProps} />` rendered anywhere in that component's
// JSX (the promise resolves — and the dialog closes — on either button).
import { useCallback, useState } from "react";

import type { ConfirmDialogProps } from "./ConfirmDialog";

export interface ConfirmOptions {
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const requestConfirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  function settle(confirmed: boolean) {
    // Resolve the promise from the *closed-over* pending value, not state
    // read after `setPending(null)` — settle is called directly from the
    // dialog's own onConfirm/onCancel, so `pending` here is always current.
    pending?.resolve(confirmed);
    setPending(null);
  }

  const dialogProps: ConfirmDialogProps = {
    open: pending !== null,
    title: pending?.title,
    message: pending?.message ?? "",
    confirmLabel: pending?.confirmLabel,
    cancelLabel: pending?.cancelLabel,
    danger: pending?.danger,
    onConfirm: () => settle(true),
    onCancel: () => settle(false),
  };

  return { requestConfirm, dialogProps };
}
