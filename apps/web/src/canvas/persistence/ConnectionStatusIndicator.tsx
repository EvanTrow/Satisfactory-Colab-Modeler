// Job 022: renders `ConnectionStatus` (`connectionStatus.ts`) — same visual
// language as `SaveStatusIndicator.tsx` (a small colored dot + label,
// `aria-live="polite"`) so the two sit naturally side by side in
// `CanvasView.tsx`'s toolbar without looking like two different UI systems.
import type { ConnectionStatus } from "./connectionStatus";

export interface ConnectionStatusIndicatorProps {
  status: ConnectionStatus;
}

const DOT_CLASS: Record<ConnectionStatus, string> = {
  connected: "bg-[var(--success)]",
  reconnecting: "bg-[var(--accent)] animate-pulse",
  offline: "bg-[var(--danger)] animate-pulse",
};

const LABEL: Record<ConnectionStatus, string> = {
  connected: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

export function ConnectionStatusIndicator({ status }: ConnectionStatusIndicatorProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
      title={`Connection: ${LABEL[status]}`}
      aria-live="polite"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[status]}`} aria-hidden />
      {LABEL[status]}
    </span>
  );
}
