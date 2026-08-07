// Job 022: renders `ConnectionStatus` (`connectionStatus.ts`) — same visual
// language as `SaveStatusIndicator.tsx` (a small colored dot + label,
// `aria-live="polite"`) so the two sit naturally side by side in
// `CanvasView.tsx`'s toolbar without looking like two different UI systems.
import { useTranslation } from "react-i18next";

import type { ConnectionStatus } from "./connectionStatus";

export interface ConnectionStatusIndicatorProps {
  status: ConnectionStatus;
}

const DOT_CLASS: Record<ConnectionStatus, string> = {
  connected: "bg-[var(--success)]",
  reconnecting: "bg-[var(--accent)] animate-pulse",
  offline: "bg-[var(--danger)] animate-pulse",
};

const LABEL_KEY: Record<ConnectionStatus, string> = {
  connected: "status.connection.connected",
  reconnecting: "status.connection.reconnecting",
  offline: "status.connection.offline",
};

export function ConnectionStatusIndicator({ status }: ConnectionStatusIndicatorProps) {
  const { t } = useTranslation("app");
  const label = t(LABEL_KEY[status]);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
      title={t("status.connection.tooltip", { label })}
      aria-live="polite"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[status]}`} aria-hidden />
      {label}
    </span>
  );
}
