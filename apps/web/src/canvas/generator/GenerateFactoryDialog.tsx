// "Generate factory" — a target-item-and-rate dialog that auto-builds a full
// production chain (see `planFactory.ts`'s header for the graph math),
// following the same modal/focus-trap shape `RecipeChooser.tsx` established
// for this app's other canvas-creating dialogs.
import { Wand2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { defaultGameData } from "@scm/gamedata";
import { formatRational, isPositive, parseRational, type Rational } from "@scm/rational";
import type { NumberFormats, SfmDocument } from "@scm/ydoc";

import { useFocusTrap } from "../../a11y";
import { getIconUrl } from "../../assets/icons";
import { useGameTerm } from "../../i18n";
import { applyFactoryPlan } from "./applyFactoryPlan";
import { planFactory } from "./planFactory";

const gameData = defaultGameData;

export interface GenerateFactoryDialogProps {
  sfmDoc: SfmDocument;
  containerId: string;
  numberFormats: NumberFormats;
  /** Top-left anchor for the generated layout — see `CanvasView.tsx`'s call site for how this clears whatever's already on the canvas. */
  basePosition: { x: number; y: number };
  onClose: () => void;
}

const ITEM_LIST_LIMIT = 40;

export function GenerateFactoryDialog({
  sfmDoc,
  containerId,
  numberFormats,
  basePosition,
  onClose,
}: GenerateFactoryDialogProps) {
  const { t } = useTranslation("app");
  const gameTerm = useGameTerm();
  const modalRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(modalRef, true, { onClose, initialFocusRef: searchInputRef });

  const [search, setSearch] = useState("");
  const [targetPart, setTargetPart] = useState<string | null>(null);
  const [rateText, setRateText] = useState("60");

  const items = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = [...gameData.parts].sort((a, b) => a.name.localeCompare(b.name));
    const filtered = query ? all.filter((part) => part.name.toLowerCase().includes(query)) : all;
    return filtered.slice(0, ITEM_LIST_LIMIT);
  }, [search]);

  let targetRate: Rational | null = null;
  try {
    const parsed = rateText.trim() ? parseRational(rateText) : null;
    targetRate = parsed && isPositive(parsed) ? parsed : null;
  } catch {
    targetRate = null;
  }

  const plan = useMemo(() => {
    if (!targetPart || !targetRate) return null;
    return planFactory(gameData, targetPart, targetRate);
  }, [targetPart, targetRate]);

  const canGenerate = !!plan && plan.nodes.length > 0;

  function handleGenerate() {
    if (!plan || plan.nodes.length === 0) return;
    applyFactoryPlan(sfmDoc, containerId, plan, { basePosition });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onMouseDown={onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("canvas.generateFactoryHeading")}
        className="flex max-h-[80vh] w-[420px] flex-col overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-primary)] shadow-[var(--shadow-modal)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Wand2 className="h-4 w-4" aria-hidden />
            {t("canvas.generateFactoryHeading")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("canvas.close")}
            className="rounded-md px-1.5 py-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            {t("canvas.generateFactoryRateLabel")}
            <input
              type="text"
              inputMode="decimal"
              value={rateText}
              onChange={(event) => setRateText(event.target.value)}
              className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>

          <div className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            <span>{t("canvas.generateFactoryTargetLabel")}</span>
            {targetPart ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-1">
                <span className="flex items-center gap-1.5 text-[var(--text-primary)]">
                  {getIconUrl(targetPart) && (
                    <img src={getIconUrl(targetPart)} alt="" className="h-5 w-5 object-contain" />
                  )}
                  {gameTerm(targetPart)}
                </span>
                <button
                  type="button"
                  onClick={() => setTargetPart(null)}
                  className="text-xs text-[var(--accent)] underline hover:text-[var(--accent-hover)]"
                >
                  {t("canvas.generateFactoryChangeItem")}
                </button>
              </div>
            ) : (
              <>
                <input
                  ref={searchInputRef}
                  type="text"
                  autoFocus
                  placeholder={t("canvas.generateFactorySearchPlaceholder")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
                <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border-subtle)]">
                  {items.length === 0 ? (
                    <p className="p-2 text-xs text-[var(--text-muted)]">{t("canvas.noRecipesMatch")}</p>
                  ) : (
                    items.map((part) => {
                      const iconUrl = getIconUrl(part.name);
                      return (
                        <button
                          key={part.name}
                          type="button"
                          onClick={() => setTargetPart(part.name)}
                          className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-[var(--surface-hover)]"
                        >
                          {iconUrl ? (
                            <img src={iconUrl} alt="" className="h-5 w-5 shrink-0 object-contain" />
                          ) : (
                            <span className="h-5 w-5 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
                          )}
                          <span className="truncate">{gameTerm(part.name)}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>

          {targetPart && !targetRate && (
            <p className="text-xs text-[var(--danger)]">{t("canvas.generateFactoryInvalidRate")}</p>
          )}

          {plan && plan.nodes.length === 0 && (
            <p className="text-xs text-[var(--danger)]">{t("canvas.generateFactoryNoRecipeForTarget")}</p>
          )}

          {plan && plan.nodes.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                {t("canvas.generateFactoryPreviewHeading", { count: plan.nodes.length })}
              </p>
              <div className="max-h-40 overflow-y-auto rounded-md border border-[var(--border-subtle)] text-xs">
                {plan.nodes.map((node) => (
                  <div
                    key={node.part}
                    className="flex items-center justify-between gap-2 px-2 py-1 odd:bg-[var(--surface-sunken)]"
                  >
                    <span className="truncate text-[var(--text-primary)]">{gameTerm(node.recipe.name)}</span>
                    <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                      {formatRational(node.machineCount, numberFormats)}×
                    </span>
                  </div>
                ))}
              </div>
              {plan.unresolvedParts.length > 0 && (
                <p className="text-xs text-[var(--mismatch)]">
                  {t("canvas.generateFactoryUnresolvedWarning", {
                    parts: plan.unresolvedParts.map(gameTerm).join(", "),
                  })}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--border-subtle)] px-4 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {t("canvas.back")}
          </button>
          <button
            type="button"
            disabled={!canGenerate}
            onClick={handleGenerate}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:enabled:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("canvas.generate")}
          </button>
        </div>
      </div>
    </div>
  );
}
