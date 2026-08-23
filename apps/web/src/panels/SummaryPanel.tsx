// Job 019: the real summary panel PLAN.md §3 asks for — "made/used/unmade/
// unused, power made/used/net, sink points, and cost-to-build, scoped to
// Everything / Current Outpost / Selected." All the actual math lives in
// `summary/summaryMath.ts` (pure, independently tested); this file is just
// the scope-selector UI + presentation over it, reading Job 018's live
// solver output via `SolverResultContext` (never calling `useSolver` itself
// — see that context's own header comment for why).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Pin, PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { defaultGameData } from "@scm/gamedata";
import { formatRational, parseRational } from "@scm/rational";
import {
  listEdges,
  listNodes,
  type EdgeRecord,
  type NodeRecord,
  type NumberFormats,
  type SfmDocument,
} from "@scm/ydoc";

import { useFocusTrap } from "../a11y";
import { getIconUrl } from "../assets/icons";
import { useGameTerm } from "../i18n";
import { useSolverResult } from "../canvas/SolverResultContext";
import type { ThemeMode } from "../theme";
import type { CanvasNode } from "../canvas/useYjsSync";
import { originalEdgeIdFromSinkEdgeId, sinkConsumerNodeId } from "../workers/sinkPassthrough";
import { originalEdgeIdFromStorageEdgeId, storageConsumerNodeId, storageProducerNodeId } from "../workers/storagePassthrough";
import { computeIssueList, sortIssueEntries, type EdgeResolution, type IssueEntry, type NodeResolution } from "./summary/computeIssueList";
import { computeOutpostIoIssues } from "./summary/computeOutpostIoIssues";
import {
  nodeIdsForScope,
  summarizeScope,
  type ScopedSummary,
  type SummaryScope,
} from "./summary/summaryMath";
import { usePopoutWindow } from "./summary/usePopoutWindow";
import { useSummaryPinned } from "./summary/useSummaryPinned";

const gameData = defaultGameData;

/** A friendly display name for any real, on-canvas node — mirrors each node component's own default-label convention (`RecipeNode.tsx`'s `gameTerm(recipe.name)`, `SinkNode.tsx`'s `defaultLabel`, `StorageNode.tsx`'s literal "Storage Container") without importing those component files into this panel. */
function nodeDisplayName(node: NodeRecord, gameTerm: (key: string) => string): string {
  if (node.title) return node.title;
  if (node.kind === "recipe") {
    const recipe = node.recipe ? gameData.recipesByName.get(node.recipe) : undefined;
    return recipe ? gameTerm(recipe.name) : node.recipe || node.id;
  }
  if (node.kind === "depot") return "Dimensional Depot Uploader";
  if (node.kind === "sink") return "AWESOME Sink";
  if (node.kind === "storage") return "Storage Container";
  if (node.kind === "splurger") return "Splurger";
  return node.id;
}

/**
 * Builds the `computeIssueList.ts` resolver callbacks from a snapshot of
 * live doc state — the "which synthetic solver id maps back to which real,
 * on-canvas node" unwinding this panel owns so `computeIssueList` itself
 * can stay a small, pure function with no `@scm/ydoc`/passthrough-worker
 * knowledge. Every synthetic id family this app currently mints
 * (`sinkConsumerNodeId`, `storageConsumerNodeId`/`storageProducerNodeId`)
 * is covered; a Splurger never appears in solver output at all
 * (`splurgerPassthrough.ts`'s own header — it's never a `SolverNode`), so
 * there's nothing to map for it.
 */
function buildIssueResolvers(
  allNodes: readonly NodeRecord[],
  allEdges: readonly EdgeRecord[],
  gameTerm: (key: string) => string,
): { resolveNode: (id: string) => NodeResolution | undefined; resolveEdge: (id: string) => EdgeResolution | undefined } {
  const nodeById = new Map(allNodes.map((n) => [n.id, n] as const));
  const edgeById = new Map(allEdges.map((e) => [e.id, e] as const));

  // Every synthetic per-part id a Sink/Storage node could produce, precomputed once — mirrors `SinkNode.tsx`'s/`StorageNode.tsx`'s own `distinctParts` derivation (every distinct part touching that node's incident edges).
  const syntheticNodeById = new Map<string, NodeRecord>();
  for (const node of allNodes) {
    if (node.kind !== "sink" && node.kind !== "depot" && node.kind !== "storage") continue;
    const parts = new Set(allEdges.filter((e) => e.fromNode === node.id || e.toNode === node.id).map((e) => e.part));
    for (const part of parts) {
      if (node.kind === "storage") {
        syntheticNodeById.set(storageConsumerNodeId(node.id, part), node);
        syntheticNodeById.set(storageProducerNodeId(node.id, part), node);
      } else {
        syntheticNodeById.set(sinkConsumerNodeId(node.id, part), node);
      }
    }
  }

  function resolveNode(solverNodeId: string): NodeResolution | undefined {
    const direct = nodeById.get(solverNodeId);
    if (direct) return { navigateNodeId: direct.id, label: nodeDisplayName(direct, gameTerm) };

    const synthetic = syntheticNodeById.get(solverNodeId);
    return synthetic ? { navigateNodeId: synthetic.id, label: nodeDisplayName(synthetic, gameTerm) } : undefined;
  }

  function resolveEdge(solverEdgeId: string): EdgeResolution | undefined {
    const realId = originalEdgeIdFromSinkEdgeId(solverEdgeId) ?? originalEdgeIdFromStorageEdgeId(solverEdgeId) ?? solverEdgeId;
    const edge = edgeById.get(realId);
    if (!edge) return undefined;
    const fromNode = nodeById.get(edge.fromNode);
    const toNode = nodeById.get(edge.toNode);
    if (!fromNode || !toNode) return undefined;
    return {
      fromNavigateNodeId: fromNode.id,
      toNavigateNodeId: toNode.id,
      fromLabel: nodeDisplayName(fromNode, gameTerm),
      toLabel: nodeDisplayName(toNode, gameTerm),
    };
  }

  return { resolveNode, resolveEdge };
}

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

/** Same reactive pattern as `useAllRecipeNodes`, but every node kind (Sink/Storage/Splurger included) — the Issues section below needs to resolve a synthetic solver id back to whatever REAL node produced it, regardless of kind. */
function useAllNodes(sfmDoc: SfmDocument): NodeRecord[] {
  const [nodes, setNodes] = useState<NodeRecord[]>(() => listNodes(sfmDoc));
  useEffect(() => {
    const sync = () => setNodes(listNodes(sfmDoc));
    sync();
    sfmDoc.nodes.observeDeep(sync);
    return () => sfmDoc.nodes.unobserveDeep(sync);
  }, [sfmDoc]);
  return nodes;
}

/** Same reactive pattern, over `sfmDoc.edges` — the Issues section needs every edge document-wide (not just the current view's) to resolve a rewritten Sink/Storage edge id back to its real endpoints. */
function useAllEdges(sfmDoc: SfmDocument): EdgeRecord[] {
  const [edges, setEdges] = useState<EdgeRecord[]>(() => listEdges(sfmDoc));
  useEffect(() => {
    const sync = () => setEdges(listEdges(sfmDoc));
    sync();
    sfmDoc.edges.observeDeep(sync);
    return () => sfmDoc.edges.unobserveDeep(sync);
  }, [sfmDoc]);
  return edges;
}

export interface SummaryPanelProps {
  sfmDoc: SfmDocument;
  /** The container currently being viewed (Job 013's `containerId`) — the anchor for the "Current Outpost" scope. */
  containerId: string;
  /** The currently-rendered canvas nodes (`useYjsSync`'s own scoped list) — used to read Job 012's `.selected` flags for the "Selected" scope, AND (calculation-validation visuals pass) to know which Issues-list entries are actually clickable right now (a node in a different, unopened container can't be `fitView`-ed to). */
  nodes: CanvasNode[];
  numberFormats: NumberFormats;
  /** Job 027: threaded through so the popped-out window's own `<html>` gets the same `dark`/`light` class as the main window — see `SummaryPanel`'s theme-sync effect below. */
  theme: ThemeMode;
  /**
   * Calculation-validation visuals pass: clicking an Issues-list entry calls
   * this with a real, on-canvas node id — `CanvasView.tsx` wires it straight
   * into the exact same `pendingFitNodeIds`/`fitView` mechanism it already
   * uses after Generate Factory, no new camera code. Only ever called for a
   * node id present in `nodes` (this component's own `nodes` prop) — see
   * `IssueRow`'s own `isNavigable` check.
   */
  onJumpToNode?: (nodeId: string) => void;
  /**
   * Fires whenever the pinned-sidebar toggle (see `pinned` state below)
   * flips, so `CanvasView.tsx` can shift `<Controls>` (zoom/fit/lock) out
   * from under the sidebar while it's docked over the canvas's left edge —
   * this component owns the actual pinned/unpinned state, this is purely a
   * read-only mirror for that one layout concern.
   */
  onPinnedChange?: (pinned: boolean) => void;
}

/**
 * The pinned sidebar's fixed width in px — matches its own `w-80` class
 * below exactly (Tailwind's `w-80` = `20rem` = `320px` at the default root
 * font size). Exported so `CanvasView.tsx` can compute how far to shift
 * `<Controls>` over without a second, driftable copy of this number.
 */
export const SUMMARY_SIDEBAR_WIDTH_PX = 320;

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

/** One part's icon (a compact version of `RecipeChooser.tsx`'s own `PartIcon`, sized for this panel's dense rows) — a blank placeholder swatch when no icon file exists, per `assets/icons.ts`'s `getIconUrl` doc comment. */
function PartIcon({ part }: { part: string }) {
  const gameTerm = useGameTerm();
  const iconUrl = getIconUrl(part);
  const label = gameTerm(part);
  return iconUrl ? (
    <img
      src={iconUrl}
      alt=""
      title={label}
      className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5"
    />
  ) : (
    <span title={label} className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
  );
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
      <td className="py-1 pr-2 text-[var(--text-primary)]">
        <span className="flex items-center gap-1.5">
          <PartIcon part={part} />
          {gameTerm(part)}
        </span>
      </td>
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

/** One severity's `--danger`/`--mismatch`/`--warning` color pair — matches the exact tokens `RecipeNode.tsx`'s own red/orange/yellow tiers use, so an Issues-list entry reads as the same problem the node/edge itself is already showing. */
const ISSUE_SEVERITY_STYLE: Record<IssueEntry["severity"], { text: string; bg: string }> = {
  invalid: { text: "text-[var(--danger)]", bg: "bg-[var(--danger-soft)]" },
  mismatched: { text: "text-[var(--mismatch)]", bg: "bg-[var(--mismatch-soft)]" },
  unresolved: { text: "text-[var(--warning)]", bg: "bg-[var(--warning-soft)]" },
};

interface IssueRowProps {
  issue: IssueEntry;
  navigableNodeIds: ReadonlySet<string>;
  onJumpToNode?: (nodeId: string) => void;
}

/** One Issues-list entry — clickable (jumps the canvas to it) only when at least one of its `navigateNodeIds` is actually in the current view; otherwise a plain, non-interactive row (still tells the user what's wrong and where, just can't fly them there from a different container). */
function IssueRow({ issue, navigableNodeIds, onJumpToNode }: IssueRowProps) {
  const style = ISSUE_SEVERITY_STYLE[issue.severity];
  const target = issue.navigateNodeIds.find((id) => navigableNodeIds.has(id));
  const content = (
    <>
      <p className={`truncate text-[11px] font-medium ${style.text}`}>{issue.label}</p>
      <p className="text-[10px] text-[var(--text-secondary)]">{issue.message}</p>
    </>
  );
  if (target && onJumpToNode) {
    return (
      <button
        type="button"
        onClick={() => onJumpToNode(target)}
        className={`w-full rounded-md ${style.bg} px-2 py-1 text-left transition-opacity hover:opacity-80`}
        title="Jump to this node"
      >
        {content}
      </button>
    );
  }
  return <div className={`rounded-md ${style.bg} px-2 py-1`}>{content}</div>;
}

interface SummaryBodyProps {
  scope: SummaryScope;
  onScopeChange: (scope: SummaryScope) => void;
  summary: ScopedSummary;
  numberFormats: NumberFormats;
  stale: boolean;
  /** Calculation-validation visuals pass — see `SummaryPanelProps.onJumpToNode`'s own doc comment. Document-wide, independent of `scope` (a user wants to know about every problem, not just the ones inside whichever scope the balance table below happens to be filtered to). */
  issues: readonly IssueEntry[];
  navigableNodeIds: ReadonlySet<string>;
  onJumpToNode?: (nodeId: string) => void;
}

/**
 * The actual content — Issues list + scope tabs + balance table + power/sink
 * readouts + cost-to-build list — extracted so it can be rendered in EITHER
 * the inline popover OR (Job 027) the popped-out window's portal without
 * duplicating this JSX. Contains no popover/portal-specific chrome of its
 * own (no backdrop, no pop-out button) — the two call sites below each wrap
 * it in whatever container makes sense for where it's rendered.
 */
function SummaryBody({ scope, onScopeChange, summary, numberFormats, stale, issues, navigableNodeIds, onJumpToNode }: SummaryBodyProps) {
  const { t } = useTranslation("app");
  const { t: tRaw } = useTranslation();
  const gameTerm = useGameTerm();
  const partNames = Object.keys(summary.perPart).sort();

  return (
    <>
      {issues.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            Issues ({issues.length})
          </p>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {issues.map((issue) => (
              <IssueRow key={issue.key} issue={issue} navigableNodeIds={navigableNodeIds} onJumpToNode={onJumpToNode} />
            ))}
          </div>
        </div>
      )}

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
              <li key={entry.part} className="flex items-center justify-between text-[var(--text-secondary)]">
                <span className="flex items-center gap-1.5">
                  <PartIcon part={entry.part} />
                  {gameTerm(entry.part)}
                </span>
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

/**
 * Live rendered height of the app toolbar (`CanvasView.tsx`'s `#scm-canvas-
 * toolbar` header row) — lets the pinned sidebar below sit flush beneath it
 * regardless of locale/viewport-driven height changes, instead of a
 * hardcoded pixel guess. `0` until the toolbar's first measurement.
 */
function useToolbarHeight(active: boolean): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = document.getElementById("scm-canvas-toolbar");
    if (!el) return;
    // Deliberately re-measure via `getBoundingClientRect()` (border-box)
    // instead of reading `entries[0].contentRect` — `contentRect` excludes
    // the toolbar's own `py-2` padding and `border-b`, which silently
    // undershoots the real height on every callback, including the initial
    // one `ResizeObserver.observe` always fires.
    const measure = () => setHeight(el.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);

  // A synchronous re-measurement the moment the sidebar actually opens —
  // `ResizeObserver`'s own callback above is tied to the rendering
  // pipeline, so it can lag arbitrarily far behind a *real* toolbar height
  // change (e.g. cloud-mode's Version-history/Share buttons or the Issues
  // badge mounting asynchronously after this component's own initial
  // mount) whenever the tab isn't actively compositing frames. Firing this
  // in `useLayoutEffect`, keyed on `active`, guarantees a correct value
  // right when it's needed instead of trusting however-stale the observer
  // last left it.
  useLayoutEffect(() => {
    if (!active) return;
    const el = document.getElementById("scm-canvas-toolbar");
    if (el) setHeight(el.getBoundingClientRect().height);
  }, [active]);

  return height;
}

export function SummaryPanel({
  sfmDoc,
  containerId,
  nodes,
  numberFormats,
  theme,
  onJumpToNode,
  onPinnedChange,
}: SummaryPanelProps) {
  const { t } = useTranslation("app");
  const { t: tRaw } = useTranslation();
  const gameTerm = useGameTerm();
  const [open, setOpen] = useState(false);
  // Pinned-to-the-side mode — a persistent left sidebar instead of the
  // popover/pop-out-window presentations, for "keep this visible while I
  // work" rather than "check it, then dismiss it." Mutually exclusive with
  // both (see `handlePin`/`handlePopOut`/`handleSummaryButtonClick` below),
  // same one-visible-presentation-at-a-time rule Job 027 already established
  // between the popover and the pop-out window. Persisted the same way the
  // minimap's own show/hide toggle is — see `useSummaryPinned.ts`.
  const { pinned, setPinned } = useSummaryPinned();
  const toolbarHeight = useToolbarHeight(pinned);
  // Mirror `pinned` out to `CanvasView.tsx` — see `onPinnedChange`'s own doc
  // comment on `SummaryPanelProps`. The cleanup un-mirrors on unmount too,
  // so `CanvasView` doesn't stay stuck thinking the sidebar's still pinned
  // once this component itself is gone.
  useEffect(() => {
    onPinnedChange?.(pinned);
    return () => onPinnedChange?.(false);
  }, [pinned, onPinnedChange]);
  const [scope, setScope] = useState<SummaryScope>("everything");
  const { result, staleness } = useSolverResult();
  const allNodes = useAllRecipeNodes(sfmDoc);
  // Calculation-validation visuals pass — see `buildIssueResolvers`'s own
  // header for why the Issues list needs every node/edge document-wide
  // (not just recipe nodes, not just the current view).
  const allNodesUnfiltered = useAllNodes(sfmDoc);
  const allEdges = useAllEdges(sfmDoc);
  // Job 027: the pop-out window — see `usePopoutWindow.ts`'s own header for
  // why this is a portal, not a second React root.
  const popout = usePopoutWindow();
  // Job 029: focus trap while the inline popover is open — same shape as
  // `SettingsMenu`/`SharingPanel`/`VersionPanel`, and directly relevant to
  // this job's own "screen-reader-reachable summary panel data" acceptance
  // criterion: a keyboard/screen-reader user needs to be able to Tab into
  // the scope tabs and the made/used/power/sink rows without focus leaking
  // back out to the canvas behind it. Deliberately NOT applied to the
  // pop-out window's own portal content below — that's a real separate
  // browser window/tab, which already gets its own native focus handling.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open && !popout.isOpen && !pinned, { onClose: () => setOpen(false) });

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

  // Sink points: same scope rule as everything else above, just applied to
  // real AWESOME Sink nodes (never Dimensional Depot Uploaders — those share
  // `sinkPassthrough.ts`'s machinery but grant no points) instead of recipe
  // nodes, then translated into the synthetic per-part consumer node ids
  // `summarizeScope` actually looks up in the solve result.
  const sinkNodesOnly = allNodesUnfiltered.filter((n) => n.kind === "sink");
  const sinkNodeIdsInScope = nodeIdsForScope({
    scope,
    allNodes: sinkNodesOnly,
    currentContainerId: containerId,
    selectedNodeIds,
  });
  const sinkConsumerNodeIds = new Set<string>();
  for (const edge of allEdges) {
    if (sinkNodeIdsInScope.has(edge.toNode)) {
      sinkConsumerNodeIds.add(sinkConsumerNodeId(edge.toNode, edge.part));
    }
  }

  const summary = summarizeScope(nodeIds, result?.nodes ?? [], nodeRecordById, gameData, sinkConsumerNodeIds);
  const stale = staleness === "stale-recomputing";

  const { resolveNode, resolveEdge } = buildIssueResolvers(allNodesUnfiltered, allEdges, gameTerm);
  const solverIssues = computeIssueList(result?.nodes ?? [], result?.edges ?? [], resolveNode, resolveEdge);
  // Outpost Inputs/Outputs nodes never reach the solver at all (same as a
  // Splurger — `computeOutpostIoIssues.ts`'s own header), so their
  // dangling/unsupported-port warnings are computed separately, directly
  // over document state, and merged in here.
  const outpostIoIssues = computeOutpostIoIssues(allNodesUnfiltered, allEdges, (node) => nodeDisplayName(node, gameTerm));
  const issues = sortIssueEntries([...solverIssues, ...outpostIoIssues]);
  const navigableNodeIds = new Set(nodes.map((n) => n.id));

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
    if (pinned) {
      setPinned(false); // already visible — this button doubles as the sidebar's own close control
      return;
    }
    setOpen((v) => !v);
  }

  function handlePopOut() {
    popout.open(t("summary.windowTitle"));
    setOpen(false); // the inline popover, the pinned sidebar, and the pop-out window are never more than one visible at once
    setPinned(false);
  }

  function handlePin() {
    setPinned(true);
    setOpen(false);
    if (popout.isOpen) popout.close();
  }

  const body = (
    <SummaryBody
      scope={scope}
      onScopeChange={setScope}
      summary={summary}
      numberFormats={numberFormats}
      stale={stale}
      issues={issues}
      navigableNodeIds={navigableNodeIds}
      onJumpToNode={onJumpToNode}
    />
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleSummaryButtonClick}
        title={tRaw("SUMMARY_PANEL")}
        aria-label={tRaw("SUMMARY_PANEL")}
        aria-expanded={open || pinned}
        className={`nodrag inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
          pinned
            ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
            : "border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
        }`}
      >
        {tRaw("SUMMARY")}
        {popout.isOpen ? ` ${t("summary.poppedOutSuffix")}` : ""}
        {/* Calculation-validation visuals pass: a quick "something's wrong" signal visible without opening the panel at all — same `--danger` token every other invalid indicator in this app uses. */}
        {issues.length > 0 && (
          <span
            className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[10px] font-semibold text-[var(--accent-contrast)]"
            title={`${issues.length} issue${issues.length === 1 ? "" : "s"}`}
          >
            {issues.length}
          </span>
        )}
      </button>
      {open && !popout.isOpen && !pinned && (
        <>
          {/*
            Same backdrop-vs-content mousedown-ordering fix `SettingsMenu.tsx`
            (Job 014) already applies — without the inner panel's own
            `stopPropagation`, this backdrop's `onMouseDown` would close the
            panel before a scope-button's `onClick` gets a chance to run.
          */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={tRaw("SUMMARY")}
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
                {/* Pin to the side — a persistent left sidebar instead of this dismissable popover. See `handlePin`/the pinned-sidebar block below. */}
                <button
                  type="button"
                  onClick={handlePin}
                  title={t("summary.pinTitle")}
                  aria-label={t("summary.pinTitle")}
                  className="rounded border border-[var(--border-default)] p-1 text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  <Pin className="h-3.5 w-3.5" aria-hidden />
                </button>
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
                  aria-label={t("summary.popOutTitle")}
                  className="rounded border border-[var(--border-default)] p-1 text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>

            {body}
          </div>
        </>
      )}
      {/*
        Pinned mode — a persistent left sidebar, docked flush beneath the app
        toolbar (`useToolbarHeight` measures `#scm-canvas-toolbar` live so
        this stays flush regardless of toolbar height changes). Unlike the
        popover above, this has no backdrop and isn't focus-trapped — it's
        meant to stay open and visible while the user keeps working the
        canvas underneath/beside it, not to be dismissed by an outside click.
      */}
      {pinned && !popout.isOpen && (
        <div
          role="complementary"
          aria-label={tRaw("SUMMARY")}
          className="fixed left-0 z-40 w-80 overflow-y-auto border-r border-[var(--border-default)] bg-[var(--surface-panel)] p-3 text-xs shadow-[var(--shadow-modal)]"
          style={{ top: toolbarHeight, bottom: 0 }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{tRaw("SUMMARY")}</p>
            <div className="flex items-center gap-2">
              {stale && <span className="text-[var(--text-muted)]">{t("summary.stale")}</span>}
              <button
                type="button"
                onClick={() => setPinned(false)}
                title={t("summary.unpinTitle")}
                aria-label={t("summary.unpinTitle")}
                className="rounded border border-[var(--border-default)] p-1 text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                <PinOff className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>

          {body}
        </div>
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
