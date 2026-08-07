// Job 019: the real summary panel PLAN.md §3 asks for — "made/used/unmade/
// unused, power made/used/net, sink points, and cost-to-build, scoped to
// Everything / Current Outpost / Selected." All the actual math lives in
// `summary/summaryMath.ts` (pure, independently tested); this file is just
// the scope-selector UI + presentation over it, reading Job 018's live
// solver output via `SolverResultContext` (never calling `useSolver` itself
// — see that context's own header comment for why).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { defaultGameData } from "@scm/gamedata";
import { formatRational, parseRational } from "@scm/rational";
import { listNodes, type NodeRecord, type NumberFormats, type SfmDocument } from "@scm/ydoc";

import { useGameTerm } from "../i18n";
import { useSolverResult } from "../canvas/SolverResultContext";
import type { ThemeMode } from "../theme";
import type { CanvasNode } from "../canvas/useYjsSync";
import {
  nodeIdsForScope,
  summarizeScope,
  type ScopedSummary,
  type SummaryScope,
} from "./summary/summaryMath";
import { usePopoutWindow } from "./summary/usePopoutWindow";

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
  /** Job 027: threaded through so the popped-out window's own `<html>` gets the same `dark`/`light` class as the main window — see `SummaryPanel`'s theme-sync effect below. */
  theme: ThemeMode;
}

const SCOPES: readonly SummaryScope[] = ["everything", "outpost", "selected"];
/**
 * Job 028: all three reuse the original string table's own
 * `EVERYTHING`/`CURRENT_OUTPOST`/`SELECTED` keys verbatim (PLAN.md §1's
 * "scoped operations" list names this exact same trio) — a clean 1:1 reuse
 * case, not a new key. Looked up in the default `translation` namespace.
 */
const SCOPE_LABEL_KEYS: Record<SummaryScope, string> = {
  everything: "EVERYTHING",
  outpost: "CURRENT_OUTPOST",
  selected: "SELECTED",
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
  const { t } = useTranslation("app");
  const gameTerm = useGameTerm();
  return (
    <tr className="border-t border-[var(--border-subtle)]">
      <td className="py-1 pr-2 text-[var(--text-primary)]">{gameTerm(part)}</td>
      <td className="py-1 text-right tabular-nums text-[var(--text-secondary)]">
        {fmt(balance.made, numberFormats)}
      </td>
      <td className="py-1 text-right tabular-nums text-[var(--text-secondary)]">
        {fmt(balance.used, numberFormats)}
      </td>
      <td
        className={`py-1 text-right tabular-nums ${balance.unmade !== ZERO_STR ? "font-medium text-[var(--danger)]" : "text-[var(--text-muted)]"}`}
        title={balance.unmade !== ZERO_STR ? t("summary.unmadeTooltip") : undefined}
      >
        {fmt(balance.unmade, numberFormats)}
      </td>
      <td
        className={`py-1 text-right tabular-nums ${balance.unused !== ZERO_STR ? "font-medium text-[var(--mismatch)]" : "text-[var(--text-muted)]"}`}
        title={balance.unused !== ZERO_STR ? t("summary.unusedTooltip") : undefined}
      >
        {fmt(balance.unused, numberFormats)}
      </td>
    </tr>
  );
}

interface SummaryBodyProps {
  scope: SummaryScope;
  onScopeChange: (scope: SummaryScope) => void;
  summary: ScopedSummary;
  numberFormats: NumberFormats;
  stale: boolean;
}

/**
 * The actual content — scope tabs + balance table + power/sink readouts +
 * cost-to-build list — extracted so it can be rendered in EITHER the inline
 * popover OR (Job 027) the popped-out window's portal without duplicating
 * this JSX. Contains no popover/portal-specific chrome of its own (no
 * backdrop, no pop-out button) — the two call sites below each wrap it in
 * whatever container makes sense for where it's rendered.
 */
function SummaryBody({ scope, onScopeChange, summary, numberFormats, stale }: SummaryBodyProps) {
  const { t } = useTranslation("app");
  const { t: tRaw } = useTranslation();
  const gameTerm = useGameTerm();
  const partNames = Object.keys(summary.perPart).sort();

  return (
    <>
      <div className="mb-3 flex gap-1" role="tablist" aria-label={t("summary.scopeAriaLabel")}>
        {SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={scope === s}
            onClick={() => onScopeChange(s)}
            className={`rounded px-2 py-1 transition-colors ${
              scope === s
                ? "bg-[var(--accent)] text-[var(--accent-contrast)]"
                : "bg-[var(--surface-sunken)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {tRaw(SCOPE_LABEL_KEYS[s])}
          </button>
        ))}
      </div>

      <div className={stale ? "opacity-50 transition-opacity" : "transition-opacity"}>
        <p className="mb-1 text-[var(--text-muted)]">
          {t("summary.nodesSolved", { solved: summary.solvedNodeCount, total: summary.nodeCount })}
        </p>

        <table className="mb-3 w-full border-collapse">
          <thead>
            <tr className="text-left text-[var(--text-muted)]">
              {/* Job 028: `PART`/`MADE`/`USED`/`UNMADE`/`UNUSED` all reuse the
                  original string table's own keys verbatim — exact 1:1
                  concepts. */}
              <th className="pb-1 font-normal">{tRaw("PART")}</th>
              <th className="pb-1 text-right font-normal">{tRaw("MADE")}</th>
              <th className="pb-1 text-right font-normal">{tRaw("USED")}</th>
              <th className="pb-1 text-right font-normal">{tRaw("UNMADE")}</th>
              <th className="pb-1 text-right font-normal">{tRaw("UNUSED")}</th>
            </tr>
          </thead>
          <tbody>
            {partNames.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-2 text-center text-[var(--text-muted)]">
                  {t("summary.nothingInScope")}
                </td>
              </tr>
            ) : (
              partNames.map((part) => (
                <BalanceRow key={part} part={part} balance={summary.perPart[part]!} numberFormats={numberFormats} />
              ))
            )}
          </tbody>
        </table>

        <div className="mb-3 space-y-0.5">
          <p className="flex justify-between text-[var(--text-secondary)]">
            <span>{tRaw("POWER_MADE")}</span>
            <span className="tabular-nums text-[var(--text-primary)]">{fmtPower(summary.powerMade)}</span>
          </p>
          <p className="flex justify-between text-[var(--text-secondary)]">
            <span>{tRaw("POWER_USED")}</span>
            <span className="tabular-nums text-[var(--text-primary)]">{fmtPower(summary.powerUsed)}</span>
          </p>
          <p className="flex justify-between text-[var(--text-secondary)]">
            {/* Job 028: reuses `AVERAGE_NET_POWER` ("Average Net Power") for
                this "Power net" row — same underlying quantity (made minus
                used), slightly different original wording, reused per this
                job's "close enough" judgement call rather than forcing an
                exact-phrase match. */}
            <span>{tRaw("AVERAGE_NET_POWER")}</span>
            <span
              className={`tabular-nums ${summary.powerNet < 0 ? "text-[var(--danger)]" : "text-[var(--text-primary)]"}`}
            >
              {fmtPower(summary.powerNet)}
            </span>
          </p>
          <p className="flex justify-between text-[var(--text-secondary)]">
            <span>{tRaw("SINK_POINTS")}</span>
            <span className="tabular-nums text-[var(--text-primary)]" title={t("summary.sinkPointsTooltip")}>
              {fmt(summary.sinkPoints, numberFormats)}
            </span>
          </p>
        </div>

        <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          {tRaw("COST_TO_BUILD")}
        </p>
        {summary.cost.length === 0 ? (
          <p className="text-[var(--text-muted)]">{t("summary.nothingInScope")}</p>
        ) : (
          <ul className="space-y-0.5">
            {summary.cost.map((entry) => (
              <li key={entry.part} className="flex justify-between text-[var(--text-secondary)]">
                <span>{gameTerm(entry.part)}</span>
                <span className="tabular-nums text-[var(--text-primary)]">
                  {fmt(entry.amount, numberFormats)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function SummaryPanel({ sfmDoc, containerId, nodes, numberFormats, theme }: SummaryPanelProps) {
  const { t } = useTranslation("app");
  const { t: tRaw } = useTranslation();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<SummaryScope>("everything");
  const { result, staleness } = useSolverResult();
  const allNodes = useAllRecipeNodes(sfmDoc);
  // Job 027: the pop-out window — see `usePopoutWindow.ts`'s own header for
  // why this is a portal, not a second React root.
  const popout = usePopoutWindow();

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
  const stale = staleness === "stale-recomputing";

  // Job 027: keep the popped-out window's own `<html>` in sync with the
  // main window's theme — `usePopoutWindow.ts` copies stylesheets once at
  // open time, but the `dark`/`light` CLASS those tokens key off (Job 014's
  // `@custom-variant dark` mechanism) is separate document state that has
  // to be re-applied whenever `theme` changes while popped out, not just
  // once at open time.
  useEffect(() => {
    if (!popout.containerEl) return;
    const root = popout.containerEl.ownerDocument.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme === "light");
  }, [popout.containerEl, theme]);

  function handleSummaryButtonClick() {
    if (popout.isOpen) {
      popout.open(t("summary.windowTitle")); // already open — this just focuses it, see usePopoutWindow's own `open()`
      return;
    }
    setOpen((v) => !v);
  }

  function handlePopOut() {
    popout.open(t("summary.windowTitle"));
    setOpen(false); // the inline popover and the pop-out window are never both visible at once
  }

  const body = (
    <SummaryBody scope={scope} onScopeChange={setScope} summary={summary} numberFormats={numberFormats} stale={stale} />
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleSummaryButtonClick}
        title={tRaw("SUMMARY_PANEL")}
        aria-label={tRaw("SUMMARY_PANEL")}
        aria-expanded={open}
        className="nodrag inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
      >
        {tRaw("SUMMARY")}
        {popout.isOpen ? ` ${t("summary.poppedOutSuffix")}` : ""}
      </button>
      {open && !popout.isOpen && (
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
              <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{tRaw("SUMMARY")}</p>
              <div className="flex items-center gap-2">
                {/*
                  Job 018's staleness state, surfaced here per PLAN.md §5
                  point 3 ("show the last result greyed/stale while
                  recomputing rather than blanking values") — the numbers
                  below stay exactly as they were (see `SummaryBody`'s own
                  `opacity-50` wrapper), this is just the textual cue that a
                  recompute is in flight.
                */}
                {stale && <span className="text-[var(--text-muted)]">{t("summary.stale")}</span>}
                {/*
                  Job 027: "pop out" — PLAN.md §3's later-phase "pop-out
                  summary windows". See `usePopoutWindow.ts`'s header for the
                  mechanism (a portal, not a second React root) and this
                  component's own `handlePopOut`/theme-sync effect above.
                */}
                <button
                  type="button"
                  onClick={handlePopOut}
                  title={t("summary.popOutTitle")}
                  className="rounded border border-[var(--border-default)] px-1.5 py-0.5 text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  {t("summary.popOutButton")}
                </button>
              </div>
            </div>

            {body}
          </div>
        </>
      )}
      {/*
        Job 027: the live pop-out — a `createPortal` into the OTHER window's
        own DOM node, still inside this exact React tree (see
        `usePopoutWindow.ts`'s header for why that's what keeps it live
        without any extra plumbing). Rendered unconditionally whenever
        `popout.containerEl` exists; nothing here duplicates `body` inline
        at the same time, since the popover above is gated on
        `!popout.isOpen`.
      */}
      {popout.containerEl &&
        createPortal(
          <div className="p-3 text-xs text-[var(--text-primary)]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{tRaw("SUMMARY")}</p>
              <div className="flex items-center gap-2">
                {stale && <span className="text-[var(--text-muted)]">{t("summary.stale")}</span>}
                <button
                  type="button"
                  onClick={popout.close}
                  title={t("summary.returnTitle")}
                  className="rounded border border-[var(--border-default)] px-1.5 py-0.5 text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  {t("summary.returnButton")}
                </button>
              </div>
            </div>
            {body}
          </div>,
          popout.containerEl,
        )}
    </div>
  );
}
