// Job 019: the real summary panel PLAN.md §3 asks for — "made/used/unmade/
// unused, power made/used/net, sink points, and cost-to-build, scoped to
// Everything / Current Outpost / Selected." All the actual math lives in
// `summary/summaryMath.ts` (pure, independently tested); this file is just
// the scope-selector UI + presentation over it, reading Job 018's live
// solver output via `SolverResultContext` (never calling `useSolver` itself
// — see that context's own header comment for why).
import { useEffect, useState } from "react";

import { defaultGameData } from "@scm/gamedata";
import { formatRational, parseRational } from "@scm/rational";
import { listNodes, type NodeRecord, type NumberFormats, type SfmDocument } from "@scm/ydoc";

import { useSolverResult } from "../canvas/SolverResultContext";
import type { CanvasNode } from "../canvas/useYjsSync";
import {
  nodeIdsForScope,
  summarizeScope,
  type ScopedSummary,
  type SummaryScope,
} from "./summary/summaryMath";

const gameData = defaultGameData;

/**
 * The whole document's recipe nodes, reactively — deliberately NOT
 * `useYjsSync`'s `nodes` (that's scoped to whichever single container is
 * currently being viewed, per Job 013's design; "Everything" and "Current
 * Outpost" both need to see every container's nodes to filter correctly —
 * see `summaryMath.ts`'s `ScopeInput.allNodes` doc comment). Mirrors
 * `useSettings.ts`'s "shallow subscribe, re-read the whole thing" pattern,
 * just over `sfmDoc.nodes` instead of `sfmDoc.settings`.
 */
function useAllRecipeNodes(sfmDoc: SfmDocument): NodeRecord[] {
  const [nodes, setNodes] = useState<NodeRecord[]>(() =>
    listNodes(sfmDoc).filter((n) => n.kind === "recipe"),
  );

  useEffect(() => {
    const sync = () => setNodes(listNodes(sfmDoc).filter((n) => n.kind === "recipe"));
    sync();
    sfmDoc.nodes.observeDeep(sync);
    return () => sfmDoc.nodes.unobserveDeep(sync);
  }, [sfmDoc]);

  return nodes;
}

export interface SummaryPanelProps {
  sfmDoc: SfmDocument;
  /** The container currently being viewed (Job 013's `containerId`) — the anchor for the "Current Outpost" scope. */
  containerId: string;
  /** The currently-rendered canvas nodes (`useYjsSync`'s own scoped list) — used only to read Job 012's `.selected` flags for the "Selected" scope. */
  nodes: CanvasNode[];
  numberFormats: NumberFormats;
}

const SCOPES: readonly SummaryScope[] = ["everything", "outpost", "selected"];
const SCOPE_LABELS: Record<SummaryScope, string> = {
  everything: "Everything",
  outpost: "Current Outpost",
  selected: "Selected",
};

const ZERO_STR = "0";

function fmt(value: string, numberFormats: NumberFormats): string {
  return formatRational(parseRational(value), numberFormats);
}

function fmtPower(mw: number): string {
  // Power is this app's one deliberate float boundary throughout (PLAN.md
  // §1) — `NumberFormats` governs exact-rational display only, so power
  // always renders as a fixed-precision decimal regardless of the current
  // number-format setting, matching every other power readout in this app
  // (`RecipeNode.tsx`/`DevNodeTools.tsx` don't run power through
  // `formatRational` either, for the same reason).
  return `${mw.toFixed(2)} MW`;
}

interface BalanceRowProps {
  part: string;
  balance: ScopedSummary["perPart"][string];
  numberFormats: NumberFormats;
}

function BalanceRow({ part, balance, numberFormats }: BalanceRowProps) {
  return (
    <tr className="border-t border-[var(--border-subtle)]">
      <td className="py-1 pr-2 text-[var(--text-primary)]">{part}</td>
      <td className="py-1 text-right tabular-nums text-[var(--text-secondary)]">
        {fmt(balance.made, numberFormats)}
      </td>
      <td className="py-1 text-right tabular-nums text-[var(--text-secondary)]">
        {fmt(balance.used, numberFormats)}
      </td>
      <td
        className={`py-1 text-right tabular-nums ${balance.unmade !== ZERO_STR ? "font-medium text-[var(--danger)]" : "text-[var(--text-muted)]"}`}
        title={balance.unmade !== ZERO_STR ? "Demand with no matching production" : undefined}
      >
        {fmt(balance.unmade, numberFormats)}
      </td>
      <td
        className={`py-1 text-right tabular-nums ${balance.unused !== ZERO_STR ? "font-medium text-[var(--mismatch)]" : "text-[var(--text-muted)]"}`}
        title={balance.unused !== ZERO_STR ? "Production with no matching consumption" : undefined}
      >
        {fmt(balance.unused, numberFormats)}
      </td>
    </tr>
  );
}

export function SummaryPanel({ sfmDoc, containerId, nodes, numberFormats }: SummaryPanelProps) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<SummaryScope>("everything");
  const { result, staleness } = useSolverResult();
  const allNodes = useAllRecipeNodes(sfmDoc);

  const nodeRecordById = new Map(allNodes.map((n) => [n.id, n] as const));
  const selectedNodeIds = new Set(
    nodes.filter((n) => n.selected && n.data.record).map((n) => n.id),
  );

  const nodeIds = nodeIdsForScope({
    scope,
    allNodes,
    currentContainerId: containerId,
    selectedNodeIds,
  });
  const summary = summarizeScope(nodeIds, result?.nodes ?? [], nodeRecordById, gameData);
  const partNames = Object.keys(summary.perPart).sort();
  const stale = staleness === "stale-recomputing";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Summary panel"
        aria-label="Summary panel"
        aria-expanded={open}
        className="nodrag inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
      >
        Summary
      </button>
      {open && (
        <>
          {/*
            Same backdrop-vs-content mousedown-ordering fix `SettingsMenu.tsx`
            (Job 014) already applies — without the inner panel's own
            `stopPropagation`, this backdrop's `onMouseDown` would close the
            panel before a scope-button's `onClick` gets a chance to run.
          */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full z-50 mt-1 max-h-[70vh] w-96 overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-3 text-xs shadow-[var(--shadow-modal)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                Summary
              </p>
              {/*
                Job 018's staleness state, surfaced here per PLAN.md §5
                point 3 ("show the last result greyed/stale while
                recomputing rather than blanking values") — the numbers
                below stay exactly as they were (see the `opacity-50` wrapper
                further down), this is just the textual cue that a recompute
                is in flight.
              */}
              {stale && <span className="text-[var(--text-muted)]">recalculating…</span>}
            </div>

            <div className="mb-3 flex gap-1" role="tablist" aria-label="Summary scope">
              {SCOPES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={scope === s}
                  onClick={() => setScope(s)}
                  className={`rounded px-2 py-1 transition-colors ${
                    scope === s
                      ? "bg-[var(--accent)] text-[var(--accent-contrast)]"
                      : "bg-[var(--surface-sunken)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {SCOPE_LABELS[s]}
                </button>
              ))}
            </div>

            <div className={stale ? "opacity-50 transition-opacity" : "transition-opacity"}>
              <p className="mb-1 text-[var(--text-muted)]">
                {summary.solvedNodeCount}/{summary.nodeCount} node(s) in scope solved
              </p>

              <table className="mb-3 w-full border-collapse">
                <thead>
                  <tr className="text-left text-[var(--text-muted)]">
                    <th className="pb-1 font-normal">Part</th>
                    <th className="pb-1 text-right font-normal">Made</th>
                    <th className="pb-1 text-right font-normal">Used</th>
                    <th className="pb-1 text-right font-normal">Unmade</th>
                    <th className="pb-1 text-right font-normal">Unused</th>
                  </tr>
                </thead>
                <tbody>
                  {partNames.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-2 text-center text-[var(--text-muted)]">
                        Nothing in scope.
                      </td>
                    </tr>
                  ) : (
                    partNames.map((part) => (
                      <BalanceRow
                        key={part}
                        part={part}
                        balance={summary.perPart[part]!}
                        numberFormats={numberFormats}
                      />
                    ))
                  )}
                </tbody>
              </table>

              <div className="mb-3 space-y-0.5">
                <p className="flex justify-between text-[var(--text-secondary)]">
                  <span>Power made</span>
                  <span className="tabular-nums text-[var(--text-primary)]">
                    {fmtPower(summary.powerMade)}
                  </span>
                </p>
                <p className="flex justify-between text-[var(--text-secondary)]">
                  <span>Power used</span>
                  <span className="tabular-nums text-[var(--text-primary)]">
                    {fmtPower(summary.powerUsed)}
                  </span>
                </p>
                <p className="flex justify-between text-[var(--text-secondary)]">
                  <span>Power net</span>
                  <span
                    className={`tabular-nums ${summary.powerNet < 0 ? "text-[var(--danger)]" : "text-[var(--text-primary)]"}`}
                  >
                    {fmtPower(summary.powerNet)}
                  </span>
                </p>
                <p className="flex justify-between text-[var(--text-secondary)]">
                  <span>Sink points</span>
                  <span
                    className="tabular-nums text-[var(--text-primary)]"
                    title="No AWESOME Sink node type exists yet (Job 017's documented limitation) — always 0."
                  >
                    {fmt(summary.sinkPoints, numberFormats)}
                  </span>
                </p>
              </div>

              <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                Cost to build
              </p>
              {summary.cost.length === 0 ? (
                <p className="text-[var(--text-muted)]">Nothing in scope.</p>
              ) : (
                <ul className="space-y-0.5">
                  {summary.cost.map((entry) => (
                    <li
                      key={entry.part}
                      className="flex justify-between text-[var(--text-secondary)]"
                    >
                      <span>{entry.part}</span>
                      <span className="tabular-nums text-[var(--text-primary)]">
                        {fmt(entry.amount, numberFormats)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
