// Job 024: the "Solving… [STOP]" affordance PLAN.md §5 point 1 describes —
// "the original's STOP button is the same affordance" as the worker
// cancellation Job 018 built and Job 023 extended with Full-mode progress
// reporting. Reads `useSolverResult()` (never a second `useSolver` call —
// see `SolverResultContext.ts`'s header comment on exactly why that's a
// real, previously-hit bug class) plus the live `Settings.solverMode`, and
// renders nothing at all unless a Full-mode solve is genuinely in flight
// right now (`staleness === "stale-recomputing"` while `mode === "full"` —
// the pending-debounce window counts too, since `stop()` cancels that just
// as correctly as an in-flight worker request).
import { getSettings, type SfmDocument, type SolverMode } from "@scm/ydoc";
import type { FullProgressInfo } from "@scm/solver";
import { useEffect, useState } from "react";

import { useSolverResult } from "./SolverResultContext";

export interface SolveStatusIndicatorProps {
  sfmDoc: SfmDocument;
}

/** Live `Settings.solverMode`, reactively — mirrors `useSettings.ts`'s own "shallow subscribe, re-read the whole thing" pattern rather than importing that hook directly, since this component only ever needs the one field. */
function useSolverMode(sfmDoc: SfmDocument): SolverMode {
  const [mode, setMode] = useState(() => getSettings(sfmDoc).solverMode);
  useEffect(() => {
    const sync = () => setMode(getSettings(sfmDoc).solverMode);
    sync();
    sfmDoc.settings.observe(sync);
    return () => sfmDoc.settings.unobserve(sync);
  }, [sfmDoc]);
  return mode;
}

/** "resolving splitter groups: 12/47" style summary of `FullProgressInfo` — coarse-grained per the job's own wording, not a blow-by-blow of every water-fill round. */
function describeProgress(info: FullProgressInfo): string {
  const phaseLabel = info.phase === "finalize" ? "finalizing edge shares" : `pass ${info.pass}`;
  const base = `${phaseLabel} — resolved ${info.resolvedCount}/${info.totalCount} nodes`;
  if (!info.waterFill) return base;
  const tierLabel = info.waterFill.tier === "top" ? "top tier" : "bottom tier";
  return `${base} (splitter/merger ${tierLabel}, round ${info.waterFill.round}, ${info.waterFill.activeCount} candidates)`;
}

export function SolveStatusIndicator({ sfmDoc }: SolveStatusIndicatorProps) {
  const { staleness, fullProgress, stop } = useSolverResult();
  const mode = useSolverMode(sfmDoc);

  const solving = mode === "full" && staleness === "stale-recomputing";
  if (!solving) return null;

  return (
    <div
      className="flex items-center gap-2 rounded-md border border-[var(--splurger-border)] bg-[var(--splurger-soft)] px-2 py-1 text-xs text-[var(--text-primary)]"
      role="status"
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--splurger)]"
      />
      <span className="max-w-[220px] truncate" title={fullProgress ? describeProgress(fullProgress) : undefined}>
        Solving… {fullProgress ? describeProgress(fullProgress) : "starting"}
      </span>
      <button
        type="button"
        onClick={stop}
        title="Stop this Full-mode solve — the last computed result stays on screen"
        className="nodrag shrink-0 rounded-md border border-[var(--danger)] px-2 py-0.5 text-[11px] font-semibold text-[var(--danger)] hover:bg-[var(--danger-soft)]"
      >
        STOP
      </button>
    </div>
  );
}
