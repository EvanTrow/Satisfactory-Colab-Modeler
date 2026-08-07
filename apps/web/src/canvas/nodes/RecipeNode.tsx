// The real recipe node card (Job 010), replacing the plain default box
// every `kind: "recipe"` node rendered as since Job 009. See this job's
// Handoff notes (jobs/010-recipe-node-ui.md) for the full writeup — this
// file's header comments cover the "what"/"why" of each piece; the Handoff
// notes cover cross-job contracts (wire format, port handle ids, the
// `validityState` slot).
//
// Job 019 swapped the stopgap per-part rate math (`stopgapPartRate`, still
// used as a fallback — see below) for Job 018's real solver output, added
// red/orange validity highlighting, wired every displayed rate/limit/clock
// value through `@scm/rational`'s `formatRational` against the live
// `Settings.numberFormats`, and greys the whole card out while a solve is
// in flight (`staleness === "stale-recomputing"`). See
// `jobs/019-summary-panel.md`'s Handoff notes for the full writeup —
// specifically the exact red-vs-orange mapping (also documented in
// `./computeValidity.ts`'s header) and why validity/rates are computed
// locally here from `SolverResultContext` rather than threaded through
// `CanvasNodeData.validityState` via `useYjsSync.ts`.
import { memo, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { defaultGameData, type Recipe, type RecipePart } from "@scm/gamedata";
import {
  abs,
  equals,
  formatRational,
  isNegative,
  isZero,
  of,
  parseRational,
  toFractionString,
  type Rational,
} from "@scm/rational";
import { listEdges, removeEdge, updateNode, type NodeRecord, type NumberFormats } from "@scm/ydoc";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { FieldPresenceRing, useRemotePresence, type RemotePresence } from "../../collab";
import { useCanvasDoc } from "../CanvasDocContext";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasNode } from "../useYjsSync";
import { computeNodeValidityState } from "./computeValidity";
import {
  clampClockPercent,
  clampShards,
  computeMachineCount,
  effectiveClockPercent,
  effectiveLimitValue,
  referenceRateAtFullClock,
  snapClockToWholeMachineCount,
  stopgapPartRate,
  type ClockSnapDirection,
} from "./recipeNodeMath";
import type { RecipeNodeValidity } from "./validityState";

const gameData = defaultGameData;

/** "invalid" -> red border, "mismatched" -> orange border, "valid"/undefined -> no highlight. See `computeValidity.ts`'s header for the exact mapping this reflects. */
function highlightBorderClass(state: RecipeNodeValidity | undefined): string | undefined {
  if (state === "invalid") return "border-[var(--danger)]";
  if (state === "mismatched") return "border-[var(--mismatch)]";
  return undefined;
}

/**
 * Same mapping as `highlightBorderClass`, for elements (Handles, text
 * inputs, the shard readout) that highlight via a `ring` (box-shadow-based,
 * so it never fights the element's own `border-color` utility for
 * specificity the way overriding `border-[...]` a second time would).
 */
function highlightRingClass(state: RecipeNodeValidity | undefined): string | undefined {
  if (state === "invalid") return "ring-2 ring-[var(--danger)]";
  if (state === "mismatched") return "ring-2 ring-[var(--mismatch)]";
  return undefined;
}

// Job 014: visual pass — every color/spacing/radius value below reads from
// `index.css`'s `@theme`-adjacent token block (`--surface-*`/`--border-*`/
// `--text-*`/`--accent*`), characterized from Ferrumium's own light theme
// (see that file's header comment) and mirrored for dark. No literal
// `neutral-*`/`indigo-*` Tailwind color utility remains in this file —
// every one of them only ever expressed *one* theme, which is exactly what
// broke dark/light parity before this job.
const stepperButtonClass =
  "nodrag flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] text-[var(--text-secondary)] hover:enabled:border-[var(--border-strong)] hover:enabled:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40";

const fieldInputClass =
  "nodrag w-16 rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-right text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none";

/**
 * Binds a text input to a "committed" `Rational`-bearing string (`node.limit`
 * / `node.clock`), letting the user type freely without every keystroke
 * fighting a Yjs-driven re-render: local text only resyncs from the
 * committed value while the field isn't focused, and `commit` (parse +
 * `updateNode`) only runs on blur/Enter. `commit` returns whether the parse
 * succeeded; a failed parse reverts the field to the last committed display
 * text rather than leaving invalid text sitting in the input (red/orange
 * *highlighting* for that case is Job 019's job, not this one's — this is
 * just "don't leave garbage behind").
 */
function useCommittedTextField(displayText: string, commit: (raw: string) => boolean) {
  const [text, setText] = useState(displayText);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(displayText);
  }, [displayText]);

  return {
    value: text,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      if (!commit(text)) setText(displayText);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") {
        setText(displayText);
        event.currentTarget.blur();
      }
    },
  };
}

/**
 * Job 019: every displayed rate now goes through `formatRational` against
 * the live `Settings.numberFormats` instead of a hardcoded
 * `toDecimalString(..., {digits: 2})` — changing the number-format setting
 * re-renders this immediately (no reload) since `numberFormats` comes from
 * `useSettings`'s reactive subscription. The exact `n/d` value is still
 * always available in the row's own `title` tooltip (`toFractionString`,
 * unaffected by the format setting) regardless of which display style is
 * chosen.
 */
function formatRate(value: Rational, numberFormats: NumberFormats): string {
  return formatRational(abs(value), numberFormats);
}

interface PartRowProps {
  part: RecipePart;
  rate: Rational;
  numberFormats: NumberFormats;
  /** Job 019: this part's port highlight (from `computeValidity.ts`'s per-node `RecipeNodeValidityState.ports`) — `undefined` means no edge issue touches this part on this node. */
  portValidity?: RecipeNodeValidity;
  /**
   * Job 011: right-clicking this row removes every edge connected to this
   * port (PLAN.md §2's Connect row — "remove by re-dragging or
   * right-clicking the part label"; see `RecipeNode`'s
   * `removeEdgesForPort` for the lookup/removal and this job's Handoff
   * notes for why "the part label" is read as this row rather than the
   * edge's own on-canvas label, which has its own distinct
   * double-right-click-to-delete gesture on `ConnectionEdge.tsx`).
   */
  onRemovePortEdges: (handleId: string) => void;
}

function PartRow({ part, rate, numberFormats, portValidity, onRemovePortEdges }: PartRowProps) {
  const input = isNegative(part.amount);
  // Port handle id contract for Job 011 (connections & waypoints) — see
  // this job's Handoff notes for the full writeup. Format:
  // `${"in"|"out"}:${part name}`, direction matching `RecipePart.amount`'s
  // sign (negative = input = "in", positive = output = "out").
  const handleId = `${input ? "in" : "out"}:${part.part}`;
  const iconUrl = getIconUrl(part.part);
  const handleHighlight = highlightRingClass(portValidity);
  const rowTitle =
    portValidity === "invalid"
      ? "This connection could not be resolved — see the node/edge for details."
      : portValidity === "mismatched"
        ? "Rate mismatch: this part's in/out rate doesn't reconcile with a connected neighbor."
        : `${input ? "Input" : "Output"}: right-click to disconnect`;

  return (
    <div
      className="group relative flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)]"
      onContextMenu={(event) => {
        event.preventDefault();
        // Stop this from bubbling up to `<ReactFlow onPaneContextMenu>`,
        // which would otherwise *also* open the Recipe Chooser (Job 009) —
        // right-clicking a node is a distinct gesture from right-clicking
        // the empty canvas background.
        event.stopPropagation();
        onRemovePortEdges(handleId);
      }}
      title={rowTitle}
    >
      {input && (
        <Handle
          type="target"
          position={Position.Left}
          id={handleId}
          className={`!h-2.5 !w-2.5 !border-2 !border-[var(--surface-card)] !bg-[var(--text-secondary)] ${handleHighlight ?? ""}`}
        />
      )}
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5"
        />
      ) : (
        <span className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
      )}
      <span
        className={`min-w-0 flex-1 truncate ${
          portValidity === "invalid"
            ? "text-[var(--danger)]"
            : portValidity === "mismatched"
              ? "text-[var(--mismatch)]"
              : "text-[var(--text-primary)]"
        }`}
      >
        {part.part}
      </span>
      <span
        className="shrink-0 tabular-nums text-[var(--text-secondary)]"
        title={toFractionString(rate)}
      >
        {formatRate(rate, numberFormats)}/min
      </span>
      {!input && (
        <Handle
          type="source"
          position={Position.Right}
          id={handleId}
          className={`!h-2.5 !w-2.5 !border-2 !border-[var(--surface-card)] !bg-[var(--text-secondary)] ${handleHighlight ?? ""}`}
        />
      )}
    </div>
  );
}

export const RecipeNode = memo(function RecipeNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc, awareness, localPresence } = useCanvasDoc();
  // Job 021: every *other* connected user's live Awareness state — drives
  // this node's remote-selection halo and the limit/clock/shards
  // field-editing indicators below. A completely separate mechanism from
  // `selected` (React Flow's own prop, Job 012's Zustand-store-driven local
  // selection) — deliberately not unified with it, see this file's own
  // `remoteSelectors` comment.
  const remotePresence = useRemotePresence(awareness);
  // Job 019: Job 018's live solver output, read from context rather than
  // calling `useSolver(sfmDoc)` directly (that would spin up one
  // scheduler/worker pair PER rendered node — see `SolverResultContext.ts`'s
  // header). React re-renders every context consumer on a Provider value
  // change regardless of `memo()`'s prop-comparison bail-out, so this node
  // re-renders whenever a new solve result lands even though its own
  // `data`/`selected` props haven't changed.
  const { nodeResultById, edgeResultById, staleness } = useSolverResult();
  // Job 019: the live, reactive number-format setting — every displayed
  // rate/limit/clock value below goes through `formatRational(value,
  // numberFormats)` instead of a hardcoded `toDecimalString`, so changing
  // the setting (`SettingsMenu.tsx`) re-renders every value immediately.
  const numberFormats = useSettings(sfmDoc).numberFormats;
  // Job 013: `CanvasNodeData.record` became optional (Job 013's outpost
  // boundary nodes don't have one) so this component — only ever mounted
  // for `type: "recipe"` nodes, which always do — needs a defensive guard
  // to satisfy the type checker. Not expected to actually trigger in
  // practice; mirrors the "!recipe" defensive fallback already below.
  // Re-bound to an explicitly-typed `const` (rather than relying on
  // flow-narrowing of `data.record` itself) specifically so the narrowing
  // survives into the `function`-declared event handlers below — plain
  // control-flow narrowing of an optional property doesn't propagate into
  // a nested function declaration that TypeScript can't prove is only
  // ever invoked synchronously (confirmed by this job's own typecheck run:
  // without this, `handleClockStep`/`handleShardStep` still saw `node` as
  // possibly `undefined`).
  const maybeNode = data.record;
  if (!maybeNode) return null;
  const node: NodeRecord = maybeNode;

  // Job 021: which remote peers currently have *this* node selected
  // (rendered as a colored halo below) and which are editing which of this
  // node's fields (rendered by `FieldPresenceRing` per field). Deliberately
  // NOT unified with `selected` (React Flow's own prop) into one code path —
  // `selected` is this client's own local selection, driven by Job 012's
  // Zustand store; `remoteSelectors` is every *other* client's own
  // independent selection, arriving over Awareness. They render as visually
  // distinct things (an accent border vs. a colored halo) on purpose.
  const remoteSelectors = remotePresence.filter((peer) => peer.state.selection.includes(id));
  function remoteEditorsFor(field: string): RemotePresence[] {
    return remotePresence.filter(
      (peer) => peer.state.editingField?.nodeId === id && peer.state.editingField?.field === field,
    );
  }

  const recipe: Recipe | undefined = node.recipe
    ? gameData.recipesByName.get(node.recipe)
    : undefined;
  const machine = node.machine ? gameData.machinesByName.get(node.machine) : undefined;
  const maxShards = machine?.maxProductionShards ?? 0;

  // Job 019: `nodeResult` is Job 018's real, graph-aware solve output for
  // THIS node — `undefined` only when no solve has ever produced anything
  // for it yet (None mode, or before the very first solve completes). Every
  // real-rate/real-count display below prefers this over the Job 010
  // stopgap local math; the stopgap remains the fallback for exactly that
  // "nothing solved yet" case (see `recipeNodeMath.ts`'s own doc comments —
  // it's not being removed, just demoted to a fallback).
  const nodeResult = nodeResultById.get(id);

  // `localMachineCount` is the Job 010 "limit/clock relationship, entirely
  // local to this node" math — kept as-is and used ONLY to drive the ± clock
  // snap buttons below (`handleClockStep`), which are inherently about "what
  // does THIS node's own limit/clock imply," independent of graph
  // propagation. `displayMachineCount` is what's actually shown to the user
  // (the "≈ N machines" readout) and fed to `PartRow` as the stopgap's own
  // fallback machine count — it prefers the solver's real, possibly
  // graph-propagated count whenever one exists, since that's strictly more
  // informative for an unpinned Basic-mode node (whose real count can't be
  // derived from `localMachineCount`'s purely-local formula at all).
  const localMachineCount = recipe ? computeMachineCount(gameData, recipe, node) : undefined;
  const canSnapClock = recipe ? !isZero(referenceRateAtFullClock(gameData, recipe, node)) : false;
  const displayMachineCount = nodeResult
    ? parseRational(nodeResult.machineCount)
    : localMachineCount;

  // Job 019: this node's own validity, computed from real solver output —
  // see `computeValidity.ts`'s header for the exact red ("invalid") vs
  // orange ("mismatched") mapping. Computed locally (not read off
  // `data.validityState`, the slot Job 010 built for exactly this) because
  // a solve result can land on a LATER render tick than the doc mutation
  // that triggered it (async debounce + worker round trip) — piping it
  // through `useYjsSync.ts`'s doc-mutation-triggered resync would either
  // need a second, parallel sync path keyed on solver-result changes, or
  // force a full Yjs-observer re-attach on every solve completion, for no
  // benefit over just reading `SolverResultContext` directly here (which
  // already re-renders this component correctly on every solve, per the
  // context-consumption note above). `CanvasNodeData.validityState` itself
  // is left exactly as Job 010 built it (always `null`) — see this job's
  // Handoff notes for the full reasoning.
  const incidentEdges = listEdges(sfmDoc)
    .filter((edge) => edge.fromNode === id || edge.toNode === id)
    .map((edge) => ({ edgeId: edge.id, part: edge.part }));
  const validityState = computeNodeValidityState(nodeResult, incidentEdges, edgeResultById);

  const limitDisplayText = recipe
    ? formatRational(effectiveLimitValue(gameData, recipe, node), numberFormats)
    : "0";
  const clockDisplayText = formatRational(effectiveClockPercent(node), numberFormats);

  function commitLimit(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    try {
      const parsed = parseRational(trimmed);
      updateNode(sfmDoc, id, { limit: toFractionString(parsed) });
      return true;
    } catch {
      return false;
    }
  }

  function commitClock(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    try {
      const parsed = parseRational(trimmed);
      updateNode(sfmDoc, id, { clock: toFractionString(clampClockPercent(parsed)) });
      return true;
    } catch {
      return false;
    }
  }

  const limitField = useCommittedTextField(limitDisplayText, commitLimit);
  const clockField = useCommittedTextField(clockDisplayText, commitClock);

  function handleClockStep(direction: ClockSnapDirection) {
    if (!recipe || !localMachineCount || isZero(localMachineCount)) return;
    const result = snapClockToWholeMachineCount(
      effectiveClockPercent(node),
      localMachineCount,
      direction,
    );
    updateNode(sfmDoc, id, { clock: toFractionString(result.clockPercent) });
  }

  function handleShardStep(delta: number) {
    const next = clampShards(node.shards + delta, maxShards);
    if (next !== node.shards) updateNode(sfmDoc, id, { shards: next });
  }

  /**
   * Job 011: right-click-on-part-label edge removal. Looks up every edge
   * touching this node at this specific port (either side — a port can be
   * both a `fromPort` and a `toPort` across different edges, though not
   * simultaneously on the same edge) and removes them all via `@scm/ydoc`'s
   * `removeEdge`. There's no index of "edges by node+port" maintained
   * anywhere (PLAN.md §4's schema doesn't have one, and this node count
   * scale doesn't need one — see PLAN.md §2: "tens to low hundreds per
   * outpost"), so this is a plain linear scan of `listEdges`, same
   * complexity class `useYjsSync.ts`'s own full-resync-on-every-change
   * already accepts.
   */
  function removeEdgesForPort(handleId: string) {
    for (const edge of listEdges(sfmDoc)) {
      if (
        (edge.fromNode === id && edge.fromPort === handleId) ||
        (edge.toNode === id && edge.toPort === handleId)
      ) {
        removeEdge(sfmDoc, edge.id);
      }
    }
  }

  const machineIconUrl = node.machine ? getIconUrl(node.machine) : undefined;

  if (!recipe) {
    // Stale/corrupt `recipe` reference (e.g. a `game_data.json` version
    // bump removed it — PLAN.md §10's open "Game-data updates" question).
    // Render just enough to be legible instead of crashing the whole
    // canvas.
    return (
      <div className="w-56 rounded-lg border border-[var(--danger)] bg-[var(--surface-card)] px-2 py-1.5 text-xs text-[var(--danger)] shadow-[var(--shadow-card)]">
        Unknown recipe: {node.recipe ?? "(none)"}
      </div>
    );
  }

  return (
    <div
      // Job 011: deliberately *not* `overflow-hidden` (Job 010 originally
      // had it here). React Flow's `<Handle>` elements (one per part row,
      // see `PartRow` above) are positioned protruding slightly past this
      // card's own edge, which is the standard React Flow visual — a
      // connection line should visually terminate right at the node's
      // border. `overflow-hidden` on this outer box clipped that
      // protruding sliver both visually AND for hit-testing, silently
      // making every handle undraggable (confirmed via
      // `document.elementsFromPoint` during this job's manual browser
      // verification: the handle was completely absent from the hit-test
      // stack at its own reported center). Job 010 never caught this
      // because it only asserted handle *presence*/attributes via
      // `querySelectorAll`, never actually dragged a connection — that's
      // this job's own scope. The header's `rounded-t-lg` below replaces
      // what `overflow-hidden` used to clip for visually, since it's the
      // only child with its own background color that would otherwise poke
      // square corners out past this card's `rounded-lg`.
      //
      // Job 014: `rounded-lg` (8px) + a 2px border matches Ferrumium's own
      // measured card metrics exactly (see `index.css`'s token-block
      // comment); `--node-header` is a fixed dark-slate-teal that doesn't
      // vary between themes (same reasoning as that comment), so the header
      // always reads clearly against either theme's card body.
      // Job 019: red/orange validity highlighting (PLAN.md §3) takes
      // precedence over the plain "selected" ring — a node's own
      // wrongness/mismatch is more important to see at a glance than
      // whether it happens to be selected. Job 018's staleness state
      // (`opacity-60` here, applied to the WHOLE card, not just the
      // numbers) greys the card out while a recompute is in flight, per
      // PLAN.md §5 point 3 ("show the last result greyed/stale while
      // recomputing rather than blanking values") — the last-known values
      // stay exactly as they were underneath, this only dims them.
      className={`relative w-64 rounded-lg border-2 bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors ${
        highlightBorderClass(validityState?.overall) ??
        (selected ? "border-[var(--accent)]" : "border-[var(--border-strong)]")
      } ${staleness === "stale-recomputing" ? "opacity-60" : ""}`}
      // Job 021: remote-selection halo — one or more *other* users currently
      // have this node selected (their own client's Awareness `selection`,
      // not this client's `selected` prop above). A `boxShadow` (not a
      // Tailwind `ring-*` utility, which can't take an arbitrary per-user
      // color) using the first remote selector's color; if more than one
      // peer has this node selected, the small avatar row below the card
      // lists every one of them, not just the first.
      style={
        remoteSelectors.length > 0
          ? { boxShadow: `0 0 0 3px ${remoteSelectors[0]!.state.color}` }
          : undefined
      }
      title={
        validityState?.overall === "invalid"
          ? "Invalid: " + (nodeResult?.issues.join("; ") || "see fields below")
          : undefined
      }
    >
      {remoteSelectors.length > 0 && (
        <div className="absolute -top-3 left-2 flex -space-x-1.5" aria-hidden>
          {remoteSelectors.map((peer) => (
            <span
              key={peer.clientId}
              title={`${peer.state.displayName} has this selected`}
              className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--surface-app)]"
              style={{ backgroundColor: peer.state.color }}
            />
          ))}
        </div>
      )}
      <div className="flex cursor-grab items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5 active:cursor-grabbing">
        {machineIconUrl ? (
          <img
            src={machineIconUrl}
            alt=""
            className="h-6 w-6 shrink-0 rounded-md bg-black/20 object-contain p-0.5 shadow-inner"
          />
        ) : (
          <span className="h-6 w-6 shrink-0 rounded-md bg-black/20" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--node-header-text)]">
            {recipe.name}
          </p>
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">
            {node.machine ?? "Unknown machine"}
            {recipe.isGenerator ? " · Generator" : ""}
          </p>
        </div>
      </div>

      <div className="divide-y divide-[var(--border-subtle)] py-0.5">
        {recipe.parts.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
            This recipe has no parts (power-only).
          </p>
        ) : (
          [...recipe.parts]
            .sort((a, b) => Number(isNegative(b.amount)) - Number(isNegative(a.amount)))
            .map((part) => {
              // Job 019: prefer the solver's real per-part rate; fall back
              // to Job 010's stopgap only when there's no solver result for
              // this node yet (None mode, or pre-first-solve) — see this
              // file's header comment and `recipeNodeMath.ts`'s own doc
              // comments for the full rationale.
              const solverRateStr = nodeResult?.partRates[part.part];
              const rate =
                solverRateStr !== undefined
                  ? parseRational(solverRateStr)
                  : stopgapPartRate(gameData, recipe, node, part, localMachineCount);
              return (
                <PartRow
                  key={part.part}
                  part={part}
                  rate={rate}
                  numberFormats={numberFormats}
                  portValidity={validityState?.ports?.[part.part]}
                  onRemovePortEdges={removeEdgesForPort}
                />
              );
            })
        )}
      </div>

      <div className="space-y-1.5 border-t border-[var(--border-subtle)] px-2 py-1.5 text-[11px]">
        <label className="flex items-center justify-between gap-2">
          <span className="text-[var(--text-secondary)]">
            Limit ({node.limitMode === "ppm" ? "ppm" : "machines"})
          </span>
          {/* Job 021: `relative` wrapper scoped to just the input (not the whole row) so `FieldPresenceRing`'s ring hugs the field itself, matching "colored ring... on the field" (PLAN.md §5). */}
          <span className="relative inline-block">
            <input
              type="text"
              inputMode="decimal"
              className={`${fieldInputClass} ${highlightRingClass(validityState?.fields?.limit) ?? ""}`}
              title={
                validityState?.fields?.limit === "invalid"
                  ? "This limit could not be resolved to a machine count."
                  : undefined
              }
              {...limitField}
              onFocus={() => {
                limitField.onFocus();
                // Job 021: soft indicator only — never disables/blocks this
                // input. The local user can keep typing here regardless of
                // who else is also focused on it; concurrent edits reconcile
                // via the CRDT's own last-write-wins semantics on blur/Enter
                // commit (PLAN.md §5's explicit "soft, never a hard lock").
                localPresence.setEditingField({ nodeId: id, field: "limit" });
              }}
              onBlur={() => {
                limitField.onBlur();
                localPresence.setEditingField(null);
              }}
            />
            <FieldPresenceRing editors={remoteEditorsFor("limit")} />
          </span>
        </label>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[var(--text-secondary)]">Clock</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={stepperButtonClass}
              disabled={!canSnapClock}
              title="Snap clock down so machine count rounds up (fewer machines needed goes away)"
              onClick={() => handleClockStep("roundUp")}
            >
              −
            </button>
            <span className="relative inline-block">
              <input
                type="text"
                inputMode="decimal"
                className={`${fieldInputClass} ${highlightRingClass(validityState?.fields?.clock) ?? ""}`}
                {...clockField}
                onFocus={() => {
                  clockField.onFocus();
                  localPresence.setEditingField({ nodeId: id, field: "clock" });
                }}
                onBlur={() => {
                  clockField.onBlur();
                  localPresence.setEditingField(null);
                }}
              />
              <FieldPresenceRing editors={remoteEditorsFor("clock")} />
            </span>
            <span className="text-[var(--text-muted)]">%</span>
            <button
              type="button"
              className={stepperButtonClass}
              disabled={!canSnapClock}
              title="Snap clock up so machine count rounds down"
              onClick={() => handleClockStep("roundDown")}
            >
              +
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[var(--text-secondary)]">Somersloops</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={stepperButtonClass}
              disabled={maxShards === 0 || node.shards <= 0}
              onClick={() => handleShardStep(-1)}
              onFocus={() => localPresence.setEditingField({ nodeId: id, field: "shards" })}
              onBlur={() => localPresence.setEditingField(null)}
            >
              −
            </button>
            <span className="relative inline-block">
              <span
                className={`w-8 rounded text-center tabular-nums text-[var(--text-primary)] ${highlightRingClass(validityState?.fields?.shards) ?? ""}`}
                title={
                  validityState?.fields?.shards === "invalid"
                    ? "This shard count exceeds the machine's cap."
                    : undefined
                }
              >
                {node.shards}/{maxShards}
              </span>
              <FieldPresenceRing editors={remoteEditorsFor("shards")} />
            </span>
            <button
              type="button"
              className={stepperButtonClass}
              disabled={maxShards === 0 || node.shards >= maxShards}
              onClick={() => handleShardStep(1)}
              onFocus={() => localPresence.setEditingField({ nodeId: id, field: "shards" })}
              onBlur={() => localPresence.setEditingField(null)}
            >
              +
            </button>
          </div>
        </div>

        {displayMachineCount && (
          <p
            className="text-right text-[var(--text-muted)]"
            title={toFractionString(displayMachineCount)}
          >
            ≈ {formatRational(displayMachineCount, numberFormats)} machine
            {equals(displayMachineCount, of(1)) ? "" : "s"}
            {nodeResult && !nodeResult.resolved ? " (unresolved — defaulted)" : ""}
          </p>
        )}
      </div>
    </div>
  );
});
