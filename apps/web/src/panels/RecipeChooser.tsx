// Job 009: the Recipe Chooser modal — opens on double-click or right-click
// of the empty canvas background (wired in `apps/web/src/canvas/CanvasView.tsx`),
// lets the user filter `@scm/gamedata`'s 332-recipe list by name/machine/
// tier/alternate, and creates a real `kind: "recipe"` node in the current
// container via `@scm/ydoc`'s `addNode` on selection. See this job's
// Handoff notes (jobs/009-recipe-chooser.md) for the full contract,
// especially what ends up in the created node's `machine`/`purity` fields
// for MultiMachine-backed recipes (Miner, Oil Extractor, Resource Well
// Extractor, Geothermal Generator, Space Elevator).
//
// No real node visuals here (Job 010 owns those) — this only needs
// `addNode` to result in *something* showing up, which it does via React
// Flow's built-in "default" node type (see `useYjsSync.ts`'s
// `nodeRecordToFlowNode`).
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import {
  defaultGameData,
  defaultVariant,
  resolveMachine,
  type Recipe,
  type ResolvedMultiMachine,
} from "@scm/gamedata";
import { addContainer, addNode } from "@scm/ydoc";

import { useFocusTrap } from "../a11y";
import { useCanvasDoc } from "../canvas";
import { useGameTerm } from "../i18n";
import {
  EMPTY_RECIPE_FILTERS,
  buildNodeInputForRecipe,
  filterRecipes,
  listChooserMachines,
  listChooserTiers,
  type RecipeChooserFilters,
  type RecipeVariantChoice,
} from "./recipeChooser/filters";

export interface RecipeChooserProps {
  /** Where (React Flow / document coordinates) the created node should be placed — the point the user double/right-clicked. */
  flowPosition: { x: number; y: number };
  /** Where (viewport/screen coordinates) to anchor the modal, so it opens "at that point" per PLAN.md §2. */
  screenPosition: { x: number; y: number };
  /** Called after a successful `addNode`, and also when the user closes without selecting (Escape / click-outside / the ✕ button) — callers can't tell the two apart from this alone, which matches the job's "closing without selecting does nothing" requirement (nothing extra needs to run either way). */
  onClose: () => void;
}

const MODAL_WIDTH = 640;
const MODAL_HEIGHT = 480;
const VIEWPORT_MARGIN = 12;

/** Keeps the modal on-screen regardless of where on the canvas the user clicked. */
function clampModalPosition(screenPosition: { x: number; y: number }): { left: number; top: number } {
  if (typeof window === "undefined") {
    return { left: screenPosition.x, top: screenPosition.y };
  }
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - MODAL_WIDTH - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - MODAL_HEIGHT - VIEWPORT_MARGIN);
  return {
    left: Math.min(Math.max(screenPosition.x, VIEWPORT_MARGIN), maxLeft),
    top: Math.min(Math.max(screenPosition.y, VIEWPORT_MARGIN), maxTop),
  };
}

export function RecipeChooser({ flowPosition, screenPosition, onClose }: RecipeChooserProps) {
  const { t } = useTranslation("app");
  const { t: tRaw } = useTranslation();
  const gameTerm = useGameTerm();
  const { sfmDoc, containerId } = useCanvasDoc();
  const gameData = defaultGameData;

  const [filters, setFilters] = useState<RecipeChooserFilters>(EMPTY_RECIPE_FILTERS);
  // Set only for a MultiMachine-backed recipe, while its variant picker is showing.
  const [pendingRecipe, setPendingRecipe] = useState<Recipe | null>(null);
  const [variantChoice, setVariantChoice] = useState<RecipeVariantChoice>({});
  // Job 013: "New Outpost" is the second thing this same double/right-click
  // gesture can create, alongside a recipe node — see PLAN.md §2's Outposts
  // row ("like folders") and this job's Scope wording ("e.g. via the Recipe
  // Chooser's canvas context menu... use judgement on exact entry point").
  // A third mutually-exclusive step, same shape as `pendingRecipe`'s
  // variant-picker step below.
  const [creatingOutpost, setCreatingOutpost] = useState(false);
  // Job 028: the default title text is translated at creation time (the
  // active locale when the outpost/Splurger is placed) — it's ordinary,
  // renamable document content afterward (`Container.title`/`NodeRecord
  // .title`, a plain CRDT string), not a live-relocalized UI label, so it
  // deliberately does NOT re-translate if the viewer later switches locale
  // — same one-time-default behavior as e.g. a word processor's "Untitled
  // Document" seed text.
  const [outpostTitle, setOutpostTitle] = useState(() => t("canvas.defaultOutpostTitle"));

  // Job 029: focus trap — see `a11y/useFocusTrap.ts`'s header for why this
  // (a true modal, unlike the other three panels below) needs it just as
  // much as they do. `modalRef` is the same element the `role="dialog"`/
  // `aria-modal` attributes below go on. `searchInputRef` is passed as the
  // trap's `initialFocusRef` so the search box (which already had its own
  // `autoFocus` since Job 009) keeps that focus rather than the trap's
  // default "focus the first focusable descendant" picking the "+ New
  // Outpost" button instead, since that button sits earlier in the DOM —
  // confirmed live to be a real regression before this fix (opening the
  // chooser landed keyboard focus on "+ New Outpost", not the search box).
  const modalRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(modalRef, true, { onClose, initialFocusRef: searchInputRef });

  const machines = useMemo(() => listChooserMachines(gameData), [gameData]);
  const tiers = useMemo(() => listChooserTiers(gameData), [gameData]);
  const recipes = useMemo(() => filterRecipes(gameData, filters), [gameData, filters]);

  // Escape closes the chooser without selecting (job's explicit requirement).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const pendingResolved = useMemo<ResolvedMultiMachine | null>(() => {
    if (!pendingRecipe) return null;
    const resolved = resolveMachine(pendingRecipe.machine, gameData);
    return resolved.kind === "multiMachine" ? resolved : null;
  }, [pendingRecipe, gameData]);

  function createNode(recipe: Recipe, choice?: RecipeVariantChoice) {
    const input = buildNodeInputForRecipe({
      gameData,
      recipe,
      containerId,
      position: flowPosition,
      variantChoice: choice,
    });
    addNode(sfmDoc, input);
    onClose();
  }

  function handleCreateOutpost() {
    addContainer(sfmDoc, {
      kind: "outpost",
      parentId: containerId,
      title: outpostTitle.trim() || t("canvas.defaultOutpostTitle"),
      color: "#d97706",
      x: flowPosition.x,
      y: flowPosition.y,
      copiesLimit: null,
    });
    onClose();
  }

  /**
   * Job 024: "+ New Splurger" — a real, distinct `kind: "splurger"` node,
   * placed immediately (no naming/variant sub-step, unlike a MultiMachine
   * recipe's variant picker — there's nothing to pick: a Splurger has no
   * recipe/machine at all). One node kind covers Splurger, Priority
   * Splitter, and Priority Merger — which one it *reads* as is purely a
   * function of how it ends up wired (see `SplurgerNode.tsx`'s header for
   * why that's the right call, matching real splitter/merger hardware's own
   * "never both multi-in and multi-out" shape).
   */
  function handleCreateSplurger() {
    addNode(sfmDoc, {
      containerId,
      kind: "splurger",
      recipe: null,
      machine: null,
      x: flowPosition.x,
      y: flowPosition.y,
      title: gameTerm("Splurger"),
      color: "#7c3aed",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
    });
    onClose();
  }

  function handlePickRecipe(recipe: Recipe) {
    const resolved = resolveMachine(recipe.machine, gameData);
    if (resolved.kind === "machine") {
      createNode(recipe);
      return;
    }
    // MultiMachine-backed recipe: prompt for a model/purity combination
    // before creating the node, defaulting to `defaultVariant`'s pick.
    const def = defaultVariant(resolved);
    setPendingRecipe(recipe);
    setVariantChoice({ model: def?.model?.name, capacity: def?.capacity?.name });
  }

  const modalPosition = clampModalPosition(screenPosition);

  return (
    // Backdrop: clicking outside the modal box closes without selecting.
    <div className="fixed inset-0 z-50 bg-black/20" onMouseDown={onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={creatingOutpost ? t("canvas.newOutpostHeading") : t("canvas.addMachine")}
        className="absolute flex flex-col overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-primary)] shadow-[var(--shadow-modal)]"
        style={{ left: modalPosition.left, top: modalPosition.top, width: MODAL_WIDTH, height: MODAL_HEIGHT }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2">
          <h3 className="text-sm font-semibold">
            {creatingOutpost ? t("canvas.newOutpostHeading") : t("canvas.addMachine")}
          </h3>
          <div className="flex items-center gap-2">
            {!creatingOutpost && !pendingRecipe && (
              <button
                type="button"
                onClick={() => setCreatingOutpost(true)}
                className="rounded-md border border-[var(--outpost-border)] bg-[var(--outpost-soft)] px-2 py-1 text-xs font-medium text-[var(--outpost)] hover:brightness-110"
                title={t("canvas.newOutpostTitle")}
              >
                {t("canvas.newOutpost")}
              </button>
            )}
            {!creatingOutpost && !pendingRecipe && (
              <button
                type="button"
                onClick={handleCreateSplurger}
                className="rounded-md border border-[var(--splurger-border)] bg-[var(--splurger-soft)] px-2 py-1 text-xs font-medium text-[var(--splurger)] hover:brightness-110"
                title={t("canvas.newSplurgerTitle")}
              >
                {t("canvas.newSplurger")}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("canvas.close")}
              className="rounded-md px-1.5 py-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              ✕
            </button>
          </div>
        </div>

        {creatingOutpost ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
              {t("canvas.outpostName")}
              <input
                type="text"
                autoFocus
                value={outpostTitle}
                onChange={(event) => setOutpostTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleCreateOutpost();
                }}
                className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-[var(--text-primary)] focus:border-[var(--outpost)] focus:outline-none"
              />
            </label>
            <div className="mt-auto flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreatingOutpost(false)}
                className="rounded-md px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                ← {t("canvas.back")}
              </button>
              <button
                type="button"
                onClick={handleCreateOutpost}
                className="rounded-md bg-[var(--outpost)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:brightness-110"
              >
                {t("canvas.createOutpost")}
              </button>
            </div>
          </div>
        ) : pendingRecipe && pendingResolved ? (
          <VariantPicker
            recipe={pendingRecipe}
            resolved={pendingResolved}
            choice={variantChoice}
            onChange={setVariantChoice}
            onConfirm={() => createNode(pendingRecipe, variantChoice)}
            onBack={() => setPendingRecipe(null)}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Left pane: the machines at least one recipe uses — clicking one sets/clears the "machine" filter on the right. */}
            <div className="w-48 shrink-0 overflow-y-auto border-r border-[var(--border-subtle)] p-2">
              {/* Job 028: reuses the original table's own `MACHINES` key verbatim. */}
              <p className="mb-1 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                {tRaw("MACHINES")}
              </p>
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, machine: null }))}
                className={`block w-full rounded-md px-2 py-1 text-left text-sm ${
                  filters.machine === null
                    ? "bg-[var(--accent)] text-[var(--accent-contrast)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                {t("canvas.allMachines")}
              </button>
              {machines.map((machine) => (
                <button
                  key={machine}
                  type="button"
                  onClick={() => setFilters((f) => ({ ...f, machine: f.machine === machine ? null : machine }))}
                  className={`block w-full truncate rounded-md px-2 py-1 text-left text-sm ${
                    filters.machine === machine
                      ? "bg-[var(--accent)] text-[var(--accent-contrast)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {gameTerm(machine)}
                </button>
              ))}
            </div>

            {/* Right pane: filterable recipe list. */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] p-2">
                <input
                  ref={searchInputRef}
                  type="text"
                  autoFocus
                  placeholder={t("canvas.searchRecipes")}
                  value={filters.search}
                  onChange={(event) => setFilters((f) => ({ ...f, search: event.target.value }))}
                  className="min-w-[140px] flex-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
                />
                <select
                  value={filters.tier ?? ""}
                  onChange={(event) => setFilters((f) => ({ ...f, tier: event.target.value || null }))}
                  className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                >
                  <option value="">{t("canvas.allTiers")}</option>
                  {tiers.map((tier) => (
                    <option key={tier.raw} value={tier.raw}>
                      {t("canvas.tierN", { tier: tier.raw })}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-sm text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={filters.alternatesOnly}
                    onChange={(event) => setFilters((f) => ({ ...f, alternatesOnly: event.target.checked }))}
                    className="accent-[var(--accent)]"
                  />
                  {t("canvas.alternatesOnly")}
                </label>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {recipes.length === 0 && (
                  <p className="p-3 text-sm text-[var(--text-muted)]">{t("canvas.noRecipesMatch")}</p>
                )}
                {recipes.map((recipe) => (
                  <button
                    key={recipe.name}
                    type="button"
                    onClick={() => handlePickRecipe(recipe)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                  >
                    <span className="truncate">{gameTerm(recipe.name)}</span>
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">
                      {gameTerm(recipe.machine)} · {recipe.tier.raw}
                      {recipe.alternate ? ` · ${t("ALTERNATE_RECIPE", { ns: "translation" })}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface VariantPickerProps {
  recipe: Recipe;
  resolved: ResolvedMultiMachine;
  choice: RecipeVariantChoice;
  onChange: (choice: RecipeVariantChoice) => void;
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * Step 2 of picking a MultiMachine-backed recipe: a couple of plain
 * `<select>`s for model/capacity (Job 010 owns any polished node-variant
 * UI — this just needs to produce a correct choice). Defaults to
 * `defaultVariant`'s pick, set by `RecipeChooser.handlePickRecipe` before
 * this renders.
 */
function VariantPicker({ recipe, resolved, choice, onChange, onConfirm, onBack }: VariantPickerProps) {
  const { t } = useTranslation("app");
  const gameTerm = useGameTerm();
  const modelNames = resolved.multiMachine.models.map((model) => model.name);
  const capacityNames = resolved.multiMachine.capacities.map((capacity) => capacity.name);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <p className="text-sm text-[var(--text-secondary)]">
        {/* `<Trans>` (not plain `t()`) so the recipe/machine names can stay
            wrapped in a real `<span>` (bold) element rather than losing that
            styling to string interpolation — see `app-en-US.json`'s
            `canvas.variantPrompt` for the `<bold>` placeholder tag this
            binds to `components`. */}
        <Trans
          t={t}
          i18nKey="canvas.variantPrompt"
          values={{ recipe: gameTerm(recipe.name), machine: gameTerm(resolved.name) }}
          components={{ bold: <span className="font-medium text-[var(--text-primary)]" /> }}
        />
      </p>

      {modelNames.length > 0 && (
        <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
          {t("canvas.model")}
          <select
            value={choice.model ?? ""}
            onChange={(event) => onChange({ ...choice, model: event.target.value })}
            className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          >
            {modelNames.map((name) => (
              <option key={name} value={name}>
                {gameTerm(name)}
              </option>
            ))}
          </select>
        </label>
      )}

      {capacityNames.length > 0 && (
        <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
          {t("canvas.purityCapacity")}
          <select
            value={choice.capacity ?? ""}
            onChange={(event) => onChange({ ...choice, capacity: event.target.value })}
            className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
          >
            {capacityNames.map((name) => (
              <option key={name} value={name}>
                {gameTerm(name)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-auto flex justify-end gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          ← {t("canvas.back")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
        >
          {t("canvas.addToCanvas")}
        </button>
      </div>
    </div>
  );
}
