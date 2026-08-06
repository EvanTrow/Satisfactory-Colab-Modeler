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
import { updateNode } from "@scm/ydoc";
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
}

function PartRow({ part, rate }: PartRowProps) {
  const input = isNegative(part.amount);
  // Port handle id contract for Job 011 (connections & waypoints) — see
  // this job's Handoff notes for the full writeup. Format:
  // `${"in"|"out"}:${part name}`, direction matching `RecipePart.amount`'s
  // sign (negative = input = "in", positive = output = "out").
  const handleId = `${input ? "in" : "out"}:${part.part}`;
  const iconUrl = getIconUrl(part.part);

  return (
    <div className="relative flex items-center gap-1.5 px-2 py-1 text-[11px]">
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
  const node = data.record;

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
      className={`w-64 overflow-hidden rounded-md border bg-neutral-900 text-neutral-100 shadow-lg ${
        selected ? "border-indigo-500" : "border-neutral-700"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950/60 px-2 py-1.5">
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
