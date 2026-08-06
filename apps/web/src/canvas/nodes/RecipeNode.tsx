// The real recipe node card (Job 010), replacing the plain default box
// every `kind: "recipe"` node rendered as since Job 009. See this job's
// Handoff notes (jobs/010-recipe-node-ui.md) for the full writeup — this
// file's header comments cover the "what"/"why" of each piece; the Handoff
// notes cover cross-job contracts (wire format, port handle ids, the
// `validityState` slot).
import { memo, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { defaultGameData, type Recipe, type RecipePart } from "@scm/gamedata";
import {
  abs,
  equals,
  isNegative,
  isZero,
  of,
  parseRational,
  toDecimalString,
  toFractionString,
  type Rational,
} from "@scm/rational";
import { listEdges, removeEdge, updateNode, type NodeRecord } from "@scm/ydoc";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { useCanvasDoc } from "../CanvasDocContext";
import type { CanvasNode } from "../useYjsSync";
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

const gameData = defaultGameData;

const stepperButtonClass =
  "nodrag flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-700 bg-neutral-800 text-neutral-200 hover:enabled:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40";

const fieldInputClass =
  "nodrag w-16 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-right text-neutral-100 focus:border-indigo-500 focus:outline-none";

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

function formatRate(value: Rational): string {
  return toDecimalString(abs(value), { digits: 2 });
}

interface PartRowProps {
  part: RecipePart;
  rate: Rational;
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

function PartRow({ part, rate, onRemovePortEdges }: PartRowProps) {
  const input = isNegative(part.amount);
  // Port handle id contract for Job 011 (connections & waypoints) — see
  // this job's Handoff notes for the full writeup. Format:
  // `${"in"|"out"}:${part name}`, direction matching `RecipePart.amount`'s
  // sign (negative = input = "in", positive = output = "out").
  const handleId = `${input ? "in" : "out"}:${part.part}`;
  const iconUrl = getIconUrl(part.part);

  return (
    <div
      className="relative flex items-center gap-1.5 px-2 py-1 text-[11px]"
      onContextMenu={(event) => {
        event.preventDefault();
        // Stop this from bubbling up to `<ReactFlow onPaneContextMenu>`,
        // which would otherwise *also* open the Recipe Chooser (Job 009) —
        // right-clicking a node is a distinct gesture from right-clicking
        // the empty canvas background.
        event.stopPropagation();
        onRemovePortEdges(handleId);
      }}
    >
      {input && (
        <Handle
          type="target"
          position={Position.Left}
          id={handleId}
          className="!h-2.5 !w-2.5 !border-neutral-500 !bg-neutral-700"
        />
      )}
      {iconUrl ? (
        <img src={iconUrl} alt="" className="h-4 w-4 shrink-0" />
      ) : (
        <span className="h-4 w-4 shrink-0 rounded-sm bg-neutral-700" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-neutral-200">{part.part}</span>
      <span className="shrink-0 tabular-nums text-neutral-400" title={toFractionString(rate)}>
        {formatRate(rate)}/min
      </span>
      {!input && (
        <Handle
          type="source"
          position={Position.Right}
          id={handleId}
          className="!h-2.5 !w-2.5 !border-neutral-500 !bg-neutral-700"
        />
      )}
    </div>
  );
}

export const RecipeNode = memo(function RecipeNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc } = useCanvasDoc();
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

  const recipe: Recipe | undefined = node.recipe ? gameData.recipesByName.get(node.recipe) : undefined;
  const machine = node.machine ? gameData.machinesByName.get(node.machine) : undefined;
  const maxShards = machine?.maxProductionShards ?? 0;

  const machineCount = recipe ? computeMachineCount(gameData, recipe, node) : undefined;
  const canSnapClock = recipe ? !isZero(referenceRateAtFullClock(gameData, recipe, node)) : false;

  const limitDisplayText = recipe
    ? toDecimalString(effectiveLimitValue(gameData, recipe, node), { digits: 4 })
    : "0";
  const clockDisplayText = toDecimalString(effectiveClockPercent(node), { digits: 2 });

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
    if (!recipe || !machineCount || isZero(machineCount)) return;
    const result = snapClockToWholeMachineCount(effectiveClockPercent(node), machineCount, direction);
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
      if ((edge.fromNode === id && edge.fromPort === handleId) || (edge.toNode === id && edge.toPort === handleId)) {
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
      <div className="w-56 rounded-md border border-red-800 bg-neutral-900 px-2 py-1.5 text-xs text-red-300">
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
      // this job's own scope. The header's `rounded-t-md` below (new)
      // replaces what `overflow-hidden` used to clip for visually, since
      // it's the only child with its own background color that would
      // otherwise poke square corners out past this card's `rounded-md`.
      className={`w-64 rounded-md border bg-neutral-900 text-neutral-100 shadow-lg ${
        selected ? "border-indigo-500" : "border-neutral-700"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-md border-b border-neutral-800 bg-neutral-950/60 px-2 py-1.5">
        {machineIconUrl ? (
          <img src={machineIconUrl} alt="" className="h-6 w-6 shrink-0" />
        ) : (
          <span className="h-6 w-6 shrink-0 rounded bg-neutral-700" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-neutral-100">{recipe.name}</p>
          <p className="truncate text-[10px] text-neutral-500">
            {node.machine ?? "Unknown machine"}
            {recipe.isGenerator ? " · Generator" : ""}
          </p>
        </div>
      </div>

      <div className="divide-y divide-neutral-800/60 py-0.5">
        {recipe.parts.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-neutral-500">This recipe has no parts (power-only).</p>
        ) : (
          [...recipe.parts]
            .sort((a, b) => Number(isNegative(b.amount)) - Number(isNegative(a.amount)))
            .map((part) => (
              <PartRow
                key={part.part}
                part={part}
                rate={stopgapPartRate(gameData, recipe, node, part, machineCount)}
                onRemovePortEdges={removeEdgesForPort}
              />
            ))
        )}
      </div>

      <div className="space-y-1.5 border-t border-neutral-800 px-2 py-1.5 text-[11px]">
        <label className="flex items-center justify-between gap-2">
          <span className="text-neutral-400">Limit ({node.limitMode === "ppm" ? "ppm" : "machines"})</span>
          <input type="text" inputMode="decimal" className={fieldInputClass} {...limitField} />
        </label>

        <div className="flex items-center justify-between gap-2">
          <span className="text-neutral-400">Clock</span>
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
            <input type="text" inputMode="decimal" className={fieldInputClass} {...clockField} />
            <span className="text-neutral-500">%</span>
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
          <span className="text-neutral-400">Somersloops</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={stepperButtonClass}
              disabled={maxShards === 0 || node.shards <= 0}
              onClick={() => handleShardStep(-1)}
            >
              −
            </button>
            <span className="w-8 text-center tabular-nums text-neutral-100">
              {node.shards}/{maxShards}
            </span>
            <button
              type="button"
              className={stepperButtonClass}
              disabled={maxShards === 0 || node.shards >= maxShards}
              onClick={() => handleShardStep(1)}
            >
              +
            </button>
          </div>
        </div>

        {machineCount && (
          <p className="text-right text-neutral-500" title={toFractionString(machineCount)}>
            ≈ {toDecimalString(machineCount, { digits: 3 })} machine{equals(machineCount, of(1)) ? "" : "s"}
          </p>
        )}
      </div>
    </div>
  );
});
