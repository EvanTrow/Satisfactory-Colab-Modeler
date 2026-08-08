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
import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { defaultGameData, type Recipe, type RecipePart } from "@scm/gamedata";
import { equals, formatRational, isNegative, of, parseRational, toFractionString, type Rational } from "@scm/rational";
import {
  listEdges,
  removeEdge,
  setPriorityOrder,
  updateNode,
  type NodeRecord,
  type NumberFormats,
} from "@scm/ydoc";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { FieldPresenceRing, useRemotePresence, type RemotePresence } from "../../collab";
import { useGameTerm } from "../../i18n";
import { useCanvasDoc } from "../CanvasDocContext";
import { isValidDragCandidate } from "../edges/connectionLogic";
import { formatRate } from "../formatRate";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasNode } from "../useYjsSync";
import { computeNodeValidityState } from "./computeValidity";
import { autoRoundFieldClass, fieldInputClass } from "./nodeFieldStyles";
import { computeMachineCount, effectiveLimitValue, orderRecipeParts, partHandleId, stopgapPartRate } from "./recipeNodeMath";
import { useCommittedTextField } from "./useCommittedTextField";
import type { RecipeNodeValidity } from "./validityState";

const gameData = defaultGameData;

/** "invalid" -> red border, "mismatched" -> orange border, "valid"/undefined -> no highlight. See `computeValidity.ts`'s header for the exact mapping this reflects. */
function highlightBorderClass(state: RecipeNodeValidity | undefined): string | undefined {
  if (state === "invalid") return "border-[var(--danger)]";
  if (state === "mismatched") return "border-[var(--mismatch)]";
  return undefined;
}

/**
 * Same mapping as `highlightBorderClass`, for elements (Handles, the limit
 * text input) that highlight via a `ring` (box-shadow-based, so it never
 * fights the element's own `border-color` utility for specificity the way
 * overriding `border-[...]` a second time would).
 */
function highlightRingClass(state: RecipeNodeValidity | undefined): string | undefined {
  if (state === "invalid") return "ring-2 ring-[var(--danger)]";
  if (state === "mismatched") return "ring-2 ring-[var(--mismatch)]";
  return undefined;
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
  /** Row reorder (drag-and-drop) — see `RecipeNode`'s `handlePartDrop` for the persisted side. `isDragging`/`isDragOver` drive this row's own drag-affordance styling. */
  isDragging: boolean;
  isDragOver: boolean;
  onRowDragStart: (handleId: string) => void;
  onRowDragOver: (handleId: string) => void;
  onRowDrop: (handleId: string) => void;
  onRowDragEnd: () => void;
  /**
   * `true` while a connection is being dragged out from ELSEWHERE on the
   * canvas and dropping it on this row's own port wouldn't produce a valid
   * edge (wrong part, or wrong direction) — see `RecipeNode`'s own
   * `fromHandle`/`isValidDragCandidate` for how this is computed. Dims this
   * row's `Handle` so only legal drop targets stay at full opacity while a
   * drag is in progress; `false` (the normal case, no drag in progress or
   * this row IS a legal target) leaves the row untouched.
   */
  isFaded: boolean;
}

function PartRow({
  part,
  rate,
  numberFormats,
  portValidity,
  onRemovePortEdges,
  isDragging,
  isDragOver,
  onRowDragStart,
  onRowDragOver,
  onRowDrop,
  onRowDragEnd,
  isFaded,
}: PartRowProps) {
  const { t } = useTranslation("app");
  const { t: tRaw } = useTranslation();
  const gameTerm = useGameTerm();
  const input = isNegative(part.amount);
  // Port handle id contract for Job 011 (connections & waypoints) — see
  // this job's Handoff notes for the full writeup. Format:
  // `${"in"|"out"}:${part name}`, direction matching `RecipePart.amount`'s
  // sign (negative = input = "in", positive = output = "out"). Also this
  // row's drag-reorder id (`partHandleId` in `recipeNodeMath.ts`) — the same
  // id space, deliberately: a row's handle id already uniquely identifies it
  // within this node, no reason for a second id scheme.
  const handleId = partHandleId(part);
  const iconUrl = getIconUrl(part.part);
  const handleHighlight = highlightRingClass(portValidity);
  const rowTitle =
    portValidity === "invalid"
      ? t("node.portTooltip.invalid")
      : portValidity === "mismatched"
        ? t("node.portTooltip.mismatched")
        : t("node.portTooltip.default", { direction: tRaw(input ? "INPUT" : "OUTPUT") });

  // While a connection is in progress and this row's port isn't a legal drop
  // target, fade the dot out and stop it from intercepting hover/drop —
  // `isValidConnection` (wired globally in `useConnectionHandlers.ts`)
  // already blocks an actual drop here regardless, so this is purely the
  // visual half of that same rule; see `isFaded`'s own doc comment above.
  const handleFadeClass = isFaded ? "opacity-20 pointer-events-none transition-opacity" : "transition-opacity";

  const icon = iconUrl ? (
    <img
      src={iconUrl}
      alt=""
      className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5"
    />
  ) : (
    <span className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
  );

  // A mousedown that starts on the connection dot (`.react-flow__handle`
  // below) must fall through to React Flow's own connection-drag handling,
  // not become a native row-reorder drag — the two both want the same
  // initial mousedown+move gesture, and once the browser's native DnD claims
  // it, the mousemove/mouseup sequence React Flow's connection logic relies
  // on never arrives, silently breaking "drag from the dot to wire up a
  // connection." Checking `event.target` inside `onDragStart` itself doesn't
  // work — verified against a live Chromium instance: once a drag is
  // recognized, the browser rewrites the `dragstart` event's `target` to the
  // nearest *draggable* ancestor (this row), discarding which nested
  // descendant the gesture actually started on. `mousedown` fires first, on
  // the real original target, so this ref captures the answer there instead
  // and `onDragStart` only has to consult it.
  const mouseDownOnHandleRef = useRef(false);

  return (
    <div
      // `nodrag`: without it, React Flow treats a mousedown-drag anywhere on
      // this row as "drag the whole node" (the default absent a
      // `dragHandle`/`nodrag` marker — only the header's `cursor-grab` was
      // ever a deliberate affordance for that). This row now has its own,
      // more specific drag gesture (native HTML5 DnD, reordering it among
      // its same-direction siblings), so it opts out of the node-level one
      // entirely rather than the two fighting over the same mousedown.
      className={`group relative flex cursor-grab items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)] active:cursor-grabbing nodrag ${
        input ? "justify-start" : "justify-end"
      } ${isDragging ? "opacity-40" : ""} ${
        isDragOver ? "ring-1 ring-inset ring-[var(--accent)]" : ""
      }`}
      draggable
      onMouseDownCapture={(event) => {
        mouseDownOnHandleRef.current = !!(event.target as HTMLElement).closest(".react-flow__handle");
      }}
      onDragStart={(event) => {
        if (mouseDownOnHandleRef.current) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", handleId);
        onRowDragStart(handleId);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        onRowDragOver(handleId);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onRowDrop(handleId);
      }}
      onDragEnd={onRowDragEnd}
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
          // Declares this element isn't itself a drag source — correct on
          // its own terms, but NOT what stops the row's native drag from
          // claiming a gesture that starts here (verified against a live
          // Chromium instance: an explicit `draggable={false}` on a nested
          // element does not override a `draggable=true` ancestor once the
          // ancestor's own drag session is already what ends up
          // recognized). See the row's own `mouseDownOnHandleRef`/
          // `onDragStart` above for the part that actually does the work.
          draggable={false}
          className={`!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--text-secondary)] ${handleFadeClass} ${handleHighlight ?? ""}`}
        />
      )}
      {input && icon}
      <span
        className={`min-w-0 truncate ${
          portValidity === "invalid"
            ? "text-[var(--danger)]"
            : portValidity === "mismatched"
              ? "text-[var(--mismatch)]"
              : "text-[var(--text-primary)]"
        }`}
      >
        {gameTerm(part.part)}
      </span>
      <span
        className="shrink-0 tabular-nums text-[var(--text-secondary)]"
        title={toFractionString(rate)}
      >
        ({formatRate(rate, numberFormats)}/min)
      </span>
      {!input && icon}
      {!input && (
        <Handle
          type="source"
          position={Position.Right}
          id={handleId}
          // See the target `Handle` above for why this is explicitly
          // non-draggable.
          draggable={false}
          className={`!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--text-secondary)] ${handleFadeClass} ${handleHighlight ?? ""}`}
        />
      )}
    </div>
  );
}

export const RecipeNode = memo(function RecipeNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { t } = useTranslation("app");
  const { t: tRaw } = useTranslation();
  const gameTerm = useGameTerm();
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
  // While ANY connection is being dragged out anywhere on the canvas (not
  // necessarily from this node), every `PartRow` below dims its own `Handle`
  // unless it's a legal drop target for that drag — see `isValidDragCandidate`.
  // Selector-scoped to just `fromHandle` (not the whole `ConnectionState`):
  // `fromHandle` is set once at drag start and only changes again at drag
  // end, unlike `toHandle`/`to`/`isValid`, which update on every pointer
  // move — reading the full state here would re-render every node on the
  // canvas on every pixel of mouse movement during a drag, not just at its
  // start/end.
  const fromHandle = useConnection((connection) => connection.fromHandle);
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
  // without this, this file's `function`-declared handlers still saw `node`
  // as possibly `undefined`).
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
  // Job 019: `nodeResult` is Job 018's real, graph-aware solve output for
  // THIS node — `undefined` only when no solve has ever produced anything
  // for it yet (None mode, or before the very first solve completes). Every
  // real-rate/real-count display below prefers this over the Job 010
  // stopgap local math; the stopgap remains the fallback for exactly that
  // "nothing solved yet" case (see `recipeNodeMath.ts`'s own doc comments —
  // it's not being removed, just demoted to a fallback).
  const nodeResult = nodeResultById.get(id);

  // `localMachineCount` is the Job 010 "limit/clock relationship, entirely
  // local to this node" math — kept as-is, used as `PartRow`'s stopgap
  // fallback machine count. `displayMachineCount` is what's actually shown
  // to the user (the "≈ N machines" readout) — it prefers the solver's
  // real, possibly graph-propagated count whenever one exists, since that's
  // strictly more informative for an unpinned Basic-mode node (whose real
  // count can't be derived from `localMachineCount`'s purely-local formula
  // at all).
  const localMachineCount = recipe ? computeMachineCount(gameData, recipe, node) : undefined;
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

  // A machine-count-mode node with no `limit` set is meant to read as
  // genuinely blank — "nothing limiting this machine, the solver derives it
  // from what's flowing in" — not as a pre-filled "1" that looks like a
  // real user-set value someone would have to notice and delete. ppm-mode
  // nodes (Miners/AWESOME Sinks) are the deliberate exception: they have no
  // upstream to derive a rate from, so they still show a concrete default
  // (the recipe's own reference rate, e.g. 60/min for a Miner) that's
  // freely overtyped, same as before. `effectiveLimitValue` itself is
  // unchanged and still drives every other consumer (the stopgap math, the
  // ± clock buttons) exactly as it always has — only this display/commit
  // pair treats "blank" as a real, distinct state for machine-count mode.
  const limitIsBlank = node.limit === null && node.limitMode === "machines";
  const limitEffectiveText = recipe
    ? formatRational(effectiveLimitValue(gameData, recipe, node), numberFormats)
    : "0";
  const limitDisplayText = limitIsBlank ? "" : limitEffectiveText;
  // A blank field still hints at what it'll actually run as: the real,
  // graph-propagated machine count from the solver when one exists (the
  // same value the "≈ N machines" readout below shows), falling back to
  // the local single-node default only before anything's solved yet.
  const limitPlaceholder = limitIsBlank
    ? displayMachineCount
      ? formatRational(displayMachineCount, numberFormats)
      : limitEffectiveText
    : undefined;

  // Job 027: "Manually touching clock or limit switches [auto-round] off"
  // (PLAN.md §2, verbatim) — `commitLimit` here and `RecipeNodeQuickSettings`
  // .tsx's own `commitClock`/`handleClockStep` (the clock field moved into
  // the right-click quick settings menu — see this file's header) all clear
  // `autoRound` in the SAME `updateNode` call as the value change,
  // unconditionally (a no-op write when it was already `false`, cheap and
  // simpler than a conditional). This call-site separation — not a Yjs
  // transaction-origin check — is what makes "was this touch manual"
  // unambiguous: `useAutoRound.ts`'s own automatic correction is the ONLY
  // code path that ever writes `clock` WITHOUT also writing
  // `autoRound: false`, and it lives in a completely different file none of
  // these ever call into. See `useAutoRound.ts`'s header for the other half
  // of this contract.
  function commitLimit(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) {
      // Clearing the field is itself a valid commit for machine-count mode
      // — it means "go back to blank/unconstrained," not "the user meant to
      // leave this untouched." ppm-mode (Miner/AWESOME Sink) has no upstream
      // to fall back on, so an empty ppm field still isn't meaningful there
      // and reverts like any other failed parse.
      if (node.limitMode !== "machines") return false;
      updateNode(sfmDoc, id, { limit: null, autoRound: false });
      return true;
    }
    try {
      const parsed = parseRational(trimmed);
      updateNode(sfmDoc, id, { limit: toFractionString(parsed), autoRound: false });
      return true;
    } catch {
      return false;
    }
  }

  const limitField = useCommittedTextField(limitDisplayText, commitLimit);

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

  /**
   * Row reorder (drag-to-reorder). `draggingPartId`/`dragOverPartId` are
   * local-only UI state — which row is currently the drag source and which
   * one it's hovering over; the actual order persists in
   * `node.priorityOrder` (see `recipeNodeMath.ts`'s "Row order" section for
   * the id encoding and `orderRecipeParts` for how it's re-applied on
   * render). Reordering is scoped to same-direction rows only (an input row
   * dropped onto an output row, or vice versa, is a no-op) — mixing the two
   * groups would fight the card's own input-left/output-right layout.
   */
  const [draggingPartId, setDraggingPartId] = useState<string | null>(null);
  const [dragOverPartId, setDragOverPartId] = useState<string | null>(null);

  function samePartDirection(a: string, b: string): boolean {
    return a.startsWith("in:") === b.startsWith("in:");
  }

  function handlePartDragStart(handleId: string) {
    setDraggingPartId(handleId);
  }

  function handlePartDragOver(handleId: string) {
    if (draggingPartId && handleId !== draggingPartId && samePartDirection(draggingPartId, handleId)) {
      setDragOverPartId(handleId);
    }
  }

  function handlePartDragEnd() {
    setDraggingPartId(null);
    setDragOverPartId(null);
  }

  function handlePartDrop(targetHandleId: string) {
    if (
      recipe &&
      draggingPartId &&
      draggingPartId !== targetHandleId &&
      samePartDirection(draggingPartId, targetHandleId)
    ) {
      const currentIds = orderRecipeParts(recipe.parts, node.priorityOrder).map(partHandleId);
      const fromIndex = currentIds.indexOf(draggingPartId);
      const toIndex = currentIds.indexOf(targetHandleId);
      if (fromIndex !== -1 && toIndex !== -1) {
        const nextIds = [...currentIds];
        nextIds.splice(fromIndex, 1);
        nextIds.splice(toIndex, 0, draggingPartId);
        setPriorityOrder(sfmDoc, id, nextIds);
      }
    }
    setDraggingPartId(null);
    setDragOverPartId(null);
  }

  const machineIconUrl = node.machine ? getIconUrl(node.machine) : undefined;

  if (!recipe) {
    // Stale/corrupt `recipe` reference (e.g. a `game_data.json` version
    // bump removed it — PLAN.md §10's open "Game-data updates" question).
    // Render just enough to be legible instead of crashing the whole
    // canvas.
    return (
      <div className="w-56 rounded-lg border border-[var(--danger)] bg-[var(--surface-card)] px-2 py-1.5 text-xs text-[var(--danger)] shadow-[var(--shadow-card)]">
        {t("node.unknownRecipe", { name: node.recipe ?? "(none)" })}
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
          ? t("node.invalid", { issues: nodeResult?.issues.join("; ") || t("node.invalidFallback") })
          : undefined
      }
    >
      {remoteSelectors.length > 0 && (
        <div className="absolute -top-3 left-2 flex -space-x-1.5" aria-hidden>
          {remoteSelectors.map((peer) => (
            <span
              key={peer.clientId}
              title={t("node.hasSelection", { name: peer.state.displayName })}
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
            {gameTerm(recipe.name)}
          </p>
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">
            {node.machine ? gameTerm(node.machine) : t("node.unknownMachine")}
            {recipe.isGenerator ? ` · ${t("node.generatorSuffix")}` : ""}
          </p>
        </div>
        {/* User-set node name (right-click → quick settings — see
            `RecipeNodeQuickSettings.tsx`), on the far side of the header
            from the recipe/part name. Only shown once it's actually been
            customized — it defaults to the recipe's own name at node
            creation, which would otherwise just duplicate the label to its
            left. */}
        {node.title && node.title !== recipe.name && (
          <p
            className="max-w-[40%] shrink-0 truncate text-right text-[10px] font-medium text-[var(--node-header-text)]/70"
            title={node.title}
          >
            {node.title}
          </p>
        )}
      </div>

      <div className="divide-y divide-[var(--border-subtle)] py-0.5">
        {recipe.parts.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">{t("node.noParts")}</p>
        ) : (
          orderRecipeParts(recipe.parts, node.priorityOrder).map((part) => {
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
              const handleId = partHandleId(part);
              const isFaded = fromHandle
                ? !(fromHandle.nodeId === id && fromHandle.id === handleId) &&
                  !isValidDragCandidate(fromHandle, {
                    nodeId: id,
                    id: handleId,
                    type: isNegative(part.amount) ? "target" : "source",
                  })
                : false;
              return (
                <PartRow
                  key={part.part}
                  part={part}
                  rate={rate}
                  numberFormats={numberFormats}
                  portValidity={validityState?.ports?.[part.part]}
                  onRemovePortEdges={removeEdgesForPort}
                  isDragging={draggingPartId === handleId}
                  isDragOver={dragOverPartId === handleId}
                  onRowDragStart={handlePartDragStart}
                  onRowDragOver={handlePartDragOver}
                  onRowDrop={handlePartDrop}
                  onRowDragEnd={handlePartDragEnd}
                  isFaded={isFaded}
                />
              );
            })
        )}
      </div>

      <div className="space-y-1.5 border-t border-[var(--border-subtle)] px-2 py-1.5 text-[11px]">
        <label className="flex items-center justify-between gap-2">
          {/* Job 028: "Limit" reuses the original string table's own `LIMIT`
              key verbatim; the "(ppm)"/"(machines)" unit suffix is left as a
              literal, untranslated abbreviation (same call as most technical
              tools — an SI/PPM-style unit code doesn't read as "English
              text" the way the rest of the label does; see this job's
              Handoff notes). */}
          <span className="text-[var(--text-secondary)]">
            {tRaw("LIMIT")} ({node.limitMode === "ppm" ? "ppm" : "machines"})
          </span>
          {/* Job 021: `relative` wrapper scoped to just the input (not the whole row) so `FieldPresenceRing`'s ring hugs the field itself, matching "colored ring... on the field" (PLAN.md §5). */}
          <span className="relative inline-block">
            <input
              type="text"
              inputMode="decimal"
              placeholder={limitPlaceholder}
              className={`${fieldInputClass} placeholder:italic placeholder:text-[var(--text-muted)] ${node.autoRound ? autoRoundFieldClass : ""} ${highlightRingClass(validityState?.fields?.limit) ?? ""}`}
              title={
                validityState?.fields?.limit === "invalid"
                  ? t("node.limitInvalidTooltip")
                  : node.autoRound
                    ? t("node.autoRoundEditTooltip")
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

        {displayMachineCount && (
          <p
            className="text-right text-[var(--text-muted)]"
            title={toFractionString(displayMachineCount)}
          >
            {/* Job 028: `n`, not i18next's magic `count` option key — this
                app's machine counts are exact `Rational`s formatted to
                arbitrary strings (fractions, mixed numbers), not the plain
                JS numbers i18next's own CLDR plural-rule resolver expects,
                so the singular/plural KEY is still chosen manually here
                (identical `equals(..., of(1))` logic the pre-i18n code
                used) rather than delegated to i18next's `count`-driven
                automatic suffix selection. */}
            ≈{" "}
            {t(
              equals(displayMachineCount, of(1)) ? "node.machineCountSingular" : "node.machineCountPlural",
              { n: formatRational(displayMachineCount, numberFormats) },
            )}
            {nodeResult && !nodeResult.resolved ? ` ${t("node.unresolvedDefaulted")}` : ""}
          </p>
        )}
      </div>
    </div>
  );
});
