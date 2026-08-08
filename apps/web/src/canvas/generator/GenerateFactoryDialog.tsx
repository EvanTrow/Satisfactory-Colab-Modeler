// "Generate factory" — a multi-item-and-rate dialog that auto-builds a full
// production chain for any number of desired output items at once (see
// `planFactory.ts`'s header for the graph math — targets that share raw
// materials/intermediates converge onto shared producer nodes), following
// the same modal/focus-trap shape `RecipeChooser.tsx` established for this
// app's other canvas-creating dialogs.
import { ChevronDown, ChevronUp, Plus, Wand2, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { defaultGameData, type RecipePart } from "@scm/gamedata";
import { formatRational, isNegative, isPositive, parseRational, type Rational } from "@scm/rational";
import type { NumberFormats, SfmDocument } from "@scm/ydoc";

import { useFocusTrap } from "../../a11y";
import { getIconUrl } from "../../assets/icons";
import { useGameTerm } from "../../i18n";
import { applyFactoryPlan } from "./applyFactoryPlan";
import { planFactory, type FactoryTarget } from "./planFactory";
import { GENERATION_PRIORITY_OPTIONS, type GenerationPriority } from "./recipePriority";

const gameData = defaultGameData;

/** Every alternate recipe in the game data, for the "which alternates are available" checklist below — computed once (`defaultGameData` is a module-level singleton, not per-render state). */
const ALTERNATE_RECIPES = gameData.recipes
  .filter((recipe) => recipe.alternate)
  .sort((a, b) => a.name.localeCompare(b.name));

export interface GenerateFactoryDialogProps {
  sfmDoc: SfmDocument;
  containerId: string;
  numberFormats: NumberFormats;
  /** Top-left anchor for the generated layout — see `CanvasView.tsx`'s call site for how this clears whatever's already on the canvas. */
  basePosition: { x: number; y: number };
  onClose: () => void;
}

const ITEM_LIST_LIMIT = 40;
const DEFAULT_RATE_TEXT = "60";

/** One row of the "items to produce" list — a part plus its own, independently-edited rate text (parsed lazily at render/generate time, same convention `RecipeNode.tsx`'s own limit field uses for free-typed numeric input). */
interface TargetRow {
  part: string;
  rateText: string;
}

function parseTargetRate(rateText: string): Rational | null {
  try {
    const trimmed = rateText.trim();
    if (!trimmed) return null;
    const parsed = parseRational(trimmed);
    return isPositive(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** One small part icon (a recipe's input or output) — a compact version of `RecipeChooser.tsx`'s own `PartIcon`, sized for the alternate-recipe checklist's single-line rows. */
function PartIcon({ part }: { part: string }) {
  const gameTerm = useGameTerm();
  const iconUrl = getIconUrl(part);
  const label = gameTerm(part);
  return iconUrl ? (
    <img src={iconUrl} alt="" title={label} className="h-4 w-4 shrink-0 object-contain" />
  ) : (
    <span title={label} className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
  );
}

/** `recipe.parts` split into inputs/outputs, matching `RecipeChooser.tsx`'s own input-left/output-right convention. */
function splitRecipeParts(parts: readonly RecipePart[]): { inputs: RecipePart[]; outputs: RecipePart[] } {
  return {
    inputs: parts.filter((p) => isNegative(p.amount)),
    outputs: parts.filter((p) => !isNegative(p.amount)),
  };
}

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
  const [targets, setTargets] = useState<TargetRow[]>([]);

  // Which recipe wins per part (`recipePriority.ts`'s full option set) and
  // whether the resulting layout gets a barycenter reordering pass
  // (`planFactory.ts`'s `computeOrganizedOrder`) — "Organize" defaults ON
  // since it's a purely cosmetic improvement with no real downside, unlike
  // `priority`, which genuinely changes which machines get built.
  const [priority, setPriority] = useState<GenerationPriority>("balanced");
  const [organizeLayout, setOrganizeLayout] = useState(true);

  // Converter recipes (ore-to-ore conversions) — off by default, matching
  // `planFactory.ts`'s own `allowConverters` default rationale: they're a
  // late-game, resource-intensive mechanic most factories don't want
  // auto-included, but `planFactory` still allows one through when it's the
  // only route to a part or clearly the intended one at that part's own
  // Tier (see `PlanFactoryOptions.allowConverters`'s doc comment).
  const [useConverters, setUseConverters] = useState(false);

  // Byproduct disposal (`FactoryPlan.byproductDisposals`) — off by default,
  // same reasoning as `useConverters`: it adds real nodes (a shared AWESOME
  // Sink, plus one conversion machine per disposed byproduct) the user
  // didn't necessarily ask for.
  const [handleByproducts, setHandleByproducts] = useState(false);

  // "Which alternate recipes are available" — every alternate is enabled by
  // default (matches `planFactory`'s own default: cheapest recipe wins
  // regardless of alternate status), and unchecking one here removes it from
  // consideration entirely (`PlanFactoryOptions.disabledRecipes`), forcing
  // the planner to fall back to the next-cheapest remaining candidate —
  // ordinarily the standard recipe.
  const [showAlternates, setShowAlternates] = useState(false);
  const [alternateSearch, setAlternateSearch] = useState("");
  const [disabledAlternates, setDisabledAlternates] = useState<ReadonlySet<string>>(() => new Set());

  function toggleAlternate(name: string) {
    setDisabledAlternates((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  function selectAllAlternates() {
    setDisabledAlternates(new Set());
  }

  function deselectAllAlternates() {
    setDisabledAlternates(new Set(ALTERNATE_RECIPES.map((recipe) => recipe.name)));
  }

  const alternateQuery = alternateSearch.trim().toLowerCase();
  const visibleAlternates = alternateQuery
    ? ALTERNATE_RECIPES.filter(
        (recipe) =>
          recipe.name.toLowerCase().includes(alternateQuery) ||
          recipe.machine.toLowerCase().includes(alternateQuery),
      )
    : ALTERNATE_RECIPES;
  const enabledAlternateCount = ALTERNATE_RECIPES.length - disabledAlternates.size;

  const selectedParts = new Set(targets.map((row) => row.part));
  const query = search.trim().toLowerCase();
  const items = [...gameData.parts]
    .filter((part) => !selectedParts.has(part.name))
    .filter((part) => !query || part.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, ITEM_LIST_LIMIT);

  function addTarget(part: string) {
    setTargets((rows) => [...rows, { part, rateText: DEFAULT_RATE_TEXT }]);
    setSearch("");
    searchInputRef.current?.focus();
  }

  function removeTarget(part: string) {
    setTargets((rows) => rows.filter((row) => row.part !== part));
  }

  function setRateText(part: string, rateText: string) {
    setTargets((rows) => rows.map((row) => (row.part === part ? { ...row, rateText } : row)));
  }

  const parsedRates = new Map(targets.map((row) => [row.part, parseTargetRate(row.rateText)]));
  const validTargets: FactoryTarget[] = targets
    .map((row) => ({ part: row.part, rate: parsedRates.get(row.part) }))
    .filter((target): target is FactoryTarget => target.rate !== null && target.rate !== undefined)
    .map((target) => ({ part: target.part, rate: target.rate as Rational }));
  const allRatesValid = targets.length > 0 && validTargets.length === targets.length;

  const plan =
    validTargets.length > 0
      ? planFactory(gameData, validTargets, {
          disabledRecipes: disabledAlternates,
          priority,
          allowConverters: useConverters,
          handleByproducts,
        })
      : null;
  const canGenerate = allRatesValid && !!plan && plan.nodes.length > 0;

  function handleGenerate() {
    if (!canGenerate || !plan) return;
    applyFactoryPlan(sfmDoc, containerId, plan, { basePosition, organize: organizeLayout });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onMouseDown={onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("canvas.generateFactoryHeading")}
        className="flex max-h-[80vh] w-[460px] flex-col overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-primary)] shadow-[var(--shadow-modal)]"
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
          {targets.length > 0 && (
            <div className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
              <span>{t("canvas.generateFactoryTargetLabel")}</span>
              <div className="flex flex-col gap-1">
                {targets.map((row) => {
                  const iconUrl = getIconUrl(row.part);
                  const invalid = parsedRates.get(row.part) == null;
                  return (
                    <div
                      key={row.part}
                      className={`flex items-center gap-2 rounded-md border px-2 py-1 ${
                        invalid ? "border-[var(--danger)]" : "border-[var(--border-default)]"
                      }`}
                    >
                      {iconUrl ? (
                        <img src={iconUrl} alt="" className="h-5 w-5 shrink-0 object-contain" />
                      ) : (
                        <span className="h-5 w-5 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                        {gameTerm(row.part)}
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={row.rateText}
                        onChange={(event) => setRateText(row.part, event.target.value)}
                        aria-label={t("canvas.generateFactoryRateLabel")}
                        title={t("canvas.generateFactoryRateLabel")}
                        className="w-20 shrink-0 rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-right text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                      />
                      <span className="shrink-0 text-xs text-[var(--text-muted)]">/min</span>
                      <button
                        type="button"
                        onClick={() => removeTarget(row.part)}
                        aria-label={t("canvas.generateFactoryRemoveItem", { item: gameTerm(row.part) })}
                        className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--danger)]"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </div>
              {!allRatesValid && (
                <p className="text-xs text-[var(--danger)]">{t("canvas.generateFactoryInvalidRate")}</p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            <span>{t("canvas.generateFactoryAddItem")}</span>
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
                      onClick={() => addTarget(part.name)}
                      className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-[var(--surface-hover)]"
                    >
                      {iconUrl ? (
                        <img src={iconUrl} alt="" className="h-5 w-5 shrink-0 object-contain" />
                      ) : (
                        <span className="h-5 w-5 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate">{gameTerm(part.name)}</span>
                      <Plus className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            <span>{t("canvas.generateFactoryPriorityLabel")}</span>
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as GenerationPriority)}
              className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              {GENERATION_PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
            <p className="text-xs text-[var(--text-muted)]">
              {t(GENERATION_PRIORITY_OPTIONS.find((option) => option.value === priority)!.descriptionKey)}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={organizeLayout}
              onChange={(event) => setOrganizeLayout(event.target.checked)}
              className="accent-[var(--accent)]"
            />
            {t("canvas.generateFactoryOrganizeLayout")}
          </label>

          <label
            className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"
            title={t("canvas.generateFactoryUseConvertersTitle")}
          >
            <input
              type="checkbox"
              checked={useConverters}
              onChange={(event) => setUseConverters(event.target.checked)}
              className="accent-[var(--accent)]"
            />
            {t("canvas.generateFactoryUseConverters")}
          </label>

          <label
            className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"
            title={t("canvas.generateFactoryHandleByproductsTitle")}
          >
            <input
              type="checkbox"
              checked={handleByproducts}
              onChange={(event) => setHandleByproducts(event.target.checked)}
              className="accent-[var(--accent)]"
            />
            {t("canvas.generateFactoryHandleByproducts")}
          </label>

          <div className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            <button
              type="button"
              onClick={() => setShowAlternates((v) => !v)}
              aria-expanded={showAlternates}
              className="flex items-center justify-between rounded-md border border-[var(--border-default)] px-2 py-1 text-left hover:bg-[var(--surface-hover)]"
            >
              <span>{t("canvas.generateFactoryAlternatesHeading")}</span>
              <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                {t("canvas.generateFactoryAlternatesCount", {
                  enabled: enabledAlternateCount,
                  total: ALTERNATE_RECIPES.length,
                })}
                {showAlternates ? (
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                )}
              </span>
            </button>
            {showAlternates && (
              <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-2">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder={t("canvas.generateFactorySearchPlaceholder")}
                    value={alternateSearch}
                    onChange={(event) => setAlternateSearch(event.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={selectAllAlternates}
                    className="shrink-0 text-xs text-[var(--accent)] underline hover:text-[var(--accent-hover)]"
                  >
                    {t("canvas.generateFactorySelectAll")}
                  </button>
                  <button
                    type="button"
                    onClick={deselectAllAlternates}
                    className="shrink-0 text-xs text-[var(--accent)] underline hover:text-[var(--accent-hover)]"
                  >
                    {t("canvas.generateFactoryDeselectAll")}
                  </button>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {visibleAlternates.length === 0 ? (
                    <p className="p-2 text-xs text-[var(--text-muted)]">{t("canvas.noRecipesMatch")}</p>
                  ) : (
                    visibleAlternates.map((recipe) => {
                      const { inputs, outputs } = splitRecipeParts(recipe.parts);
                      return (
                        <label
                          key={recipe.name}
                          title={gameTerm(recipe.machine)}
                          className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-[var(--surface-hover)]"
                        >
                          <input
                            type="checkbox"
                            checked={!disabledAlternates.has(recipe.name)}
                            onChange={() => toggleAlternate(recipe.name)}
                            className="shrink-0 accent-[var(--accent)]"
                          />
                          {/* Same `grid-cols-[1fr_auto_1fr]` layout `RecipeChooser.tsx`'s own `RecipeRow` uses — inputs hug the far left, outputs hug the far right, and the name is genuinely centered between them (not just left-aligned in the remaining space). */}
                          <span className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center gap-1">
                            <span className="flex items-center justify-start gap-0.5">
                              {inputs.map((part) => (
                                <PartIcon key={part.part} part={part.part} />
                              ))}
                            </span>
                            <span className="truncate text-center text-[var(--text-primary)]">
                              {gameTerm(recipe.name)}
                            </span>
                            <span className="flex items-center justify-end gap-0.5">
                              {outputs.map((part) => (
                                <PartIcon key={part.part} part={part.part} />
                              ))}
                            </span>
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

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
              {plan.byproductDisposals.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-[var(--text-secondary)]">
                    {t("canvas.generateFactoryByproductsHeading")}
                  </p>
                  <div className="rounded-md border border-[var(--border-subtle)] text-xs">
                    {plan.byproductDisposals.map((disposal) => {
                      // A disposal can report BOTH outcomes at once: some of
                      // it reused to cut back a raw extractor, some of it
                      // (any genuine leftover) converted/packaged/sunk — or,
                      // for a fluid/gas with no packaging route, left
                      // disconnected entirely (never sunk raw).
                      const notes: string[] = [];
                      if (disposal.reuse) notes.push(t("canvas.generateFactoryByproductReused"));
                      if (isPositive(disposal.disposalRate)) {
                        notes.push(
                          disposal.conversion
                            ? t("canvas.generateFactoryByproductConverted", {
                                item: gameTerm(disposal.conversion.outputPart),
                              })
                            : disposal.rawSinkAllowed
                              ? t("canvas.generateFactoryByproductSunk")
                              : t("canvas.generateFactoryByproductUnsinkable"),
                        );
                      }
                      return (
                        <div
                          key={disposal.part}
                          className="flex items-center gap-1.5 px-2 py-1 odd:bg-[var(--surface-sunken)]"
                        >
                          <PartIcon part={disposal.part} />
                          <span className="truncate text-[var(--text-primary)]">{gameTerm(disposal.part)}</span>
                          <span className="shrink-0 text-[var(--text-muted)]">{notes.join(" · ")}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
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
