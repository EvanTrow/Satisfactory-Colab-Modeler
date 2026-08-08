// The "everything above Limit" fields (name, clock speed, auto-round,
// somersloops) that `RecipeNode.tsx` no longer renders directly on the
// card — they now live here, inside the right-click node context menu
// (`../outposts/NodeContextMenu.tsx`'s real-node branch), so the card
// itself stays compact and only the Limit field is a one-click edit.
// Deliberately does NOT call the menu's own `onClose` from any of these
// fields' handlers — per the request that spawned this, the menu should
// only close when the user clicks off it, not after every keystroke or
// toggle.
import { Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { defaultGameData } from "@scm/gamedata";
import { formatRational, isZero, parseRational, toFractionString } from "@scm/rational";
import { updateNode, type NodeRecord, type NumberFormats } from "@scm/ydoc";

import { useCanvasDoc } from "../CanvasDocContext";
import {
  clampClockPercent,
  clampShards,
  effectiveClockPercent,
  referenceRateAtFullClock,
  stepClockToPreset,
  type ClockStepDirection,
} from "./recipeNodeMath";
import { autoRoundFieldClass, fieldInputClass, stepperButtonClass } from "./nodeFieldStyles";
import { useCommittedTextField } from "./useCommittedTextField";

const gameData = defaultGameData;

export interface RecipeNodeQuickSettingsProps {
  record: NodeRecord;
  numberFormats: NumberFormats;
}

export function RecipeNodeQuickSettings({ record, numberFormats }: RecipeNodeQuickSettingsProps) {
  const { t } = useTranslation("app");
  const { t: tRaw } = useTranslation();
  const { sfmDoc, localPresence } = useCanvasDoc();

  const recipe = record.recipe ? gameData.recipesByName.get(record.recipe) : undefined;
  const machine = record.machine ? gameData.machinesByName.get(record.machine) : undefined;
  const maxShards = machine?.maxProductionShards ?? 0;
  const canSnapClock = recipe ? !isZero(referenceRateAtFullClock(gameData, recipe, record)) : false;
  // Clock/auto-round/somersloops only make sense for a real recipe node —
  // Splurger/Sink/Depot/Storage have no machine to clock or overclock at
  // all. Every one of these kinds still gets the Name field below, though.
  const hasMachineFields = record.kind === "recipe";

  function commitTitle(raw: string): boolean {
    updateNode(sfmDoc, record.id, { title: raw.trim() });
    return true;
  }

  function commitClock(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    try {
      const parsed = parseRational(trimmed);
      updateNode(sfmDoc, record.id, { clock: toFractionString(clampClockPercent(parsed)), autoRound: false });
      return true;
    } catch {
      return false;
    }
  }

  function handleClockStep(direction: ClockStepDirection) {
    if (!canSnapClock) return;
    const nextClock = stepClockToPreset(effectiveClockPercent(record), direction);
    updateNode(sfmDoc, record.id, { clock: toFractionString(nextClock), autoRound: false });
  }

  function handleAutoRoundToggle(checked: boolean) {
    updateNode(sfmDoc, record.id, { autoRound: checked });
  }

  function handleShardStep(delta: number) {
    const next = clampShards(record.shards + delta, maxShards);
    if (next !== record.shards) updateNode(sfmDoc, record.id, { shards: next });
  }

  const clockDisplayText = formatRational(effectiveClockPercent(record), numberFormats);
  const titleField = useCommittedTextField(record.title, commitTitle);
  const clockField = useCommittedTextField(clockDisplayText, commitClock);

  return (
    <div className="space-y-1.5 px-2 py-1.5 text-[11px]">
      <label className="flex items-center justify-between gap-2">
        <span className="text-[var(--text-secondary)]">{t("node.name")}</span>
        <input
          type="text"
          placeholder={t("node.namePlaceholder")}
          className={`${fieldInputClass} w-32 placeholder:italic placeholder:text-[var(--text-muted)]`}
          {...titleField}
          onFocus={() => {
            titleField.onFocus();
            localPresence.setEditingField({ nodeId: record.id, field: "title" });
          }}
          onBlur={() => {
            titleField.onBlur();
            localPresence.setEditingField(null);
          }}
        />
      </label>

      {hasMachineFields && (
      <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--text-secondary)]">{tRaw("CLOCKSPEED")}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={stepperButtonClass}
            disabled={!canSnapClock}
            title={t("node.clockStepHelp")}
            aria-label={t("node.clockStepDownLabel")}
            onClick={() => handleClockStep("down")}
          >
            <Minus className="h-3 w-3" aria-hidden />
          </button>
          <input
            type="text"
            inputMode="decimal"
            className={`${fieldInputClass} ${record.autoRound ? autoRoundFieldClass : ""}`}
            title={record.autoRound ? t("node.autoRoundEditTooltip") : undefined}
            {...clockField}
            onFocus={() => {
              clockField.onFocus();
              localPresence.setEditingField({ nodeId: record.id, field: "clock" });
            }}
            onBlur={() => {
              clockField.onBlur();
              localPresence.setEditingField(null);
            }}
          />
          <span className="text-[var(--text-muted)]">%</span>
          <button
            type="button"
            className={stepperButtonClass}
            disabled={!canSnapClock}
            title={t("node.clockStepHelp")}
            aria-label={t("node.clockStepUpLabel")}
            onClick={() => handleClockStep("up")}
          >
            <Plus className="h-3 w-3" aria-hidden />
          </button>
        </div>
      </div>

      <label className="flex items-center justify-between gap-2">
        <span className="text-[var(--text-secondary)]" title={tRaw("AUTO_ROUND_HELP")}>
          {tRaw("AUTO_ROUND")}
        </span>
        <input
          type="checkbox"
          checked={record.autoRound}
          onChange={(event) => handleAutoRoundToggle(event.target.checked)}
          className="accent-[var(--accent)]"
        />
      </label>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--text-secondary)]">{t("node.somersloops")}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={stepperButtonClass}
            disabled={maxShards === 0 || record.shards <= 0}
            aria-label={t("node.shardStepDownLabel")}
            onClick={() => handleShardStep(-1)}
            onFocus={() => localPresence.setEditingField({ nodeId: record.id, field: "shards" })}
            onBlur={() => localPresence.setEditingField(null)}
          >
            <Minus className="h-3 w-3" aria-hidden />
          </button>
          <span className="w-8 text-center tabular-nums text-[var(--text-primary)]">
            {record.shards}/{maxShards}
          </span>
          <button
            type="button"
            className={stepperButtonClass}
            disabled={maxShards === 0 || record.shards >= maxShards}
            aria-label={t("node.shardStepUpLabel")}
            onClick={() => handleShardStep(1)}
            onFocus={() => localPresence.setEditingField({ nodeId: record.id, field: "shards" })}
            onBlur={() => localPresence.setEditingField(null)}
          >
            <Plus className="h-3 w-3" aria-hidden />
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
