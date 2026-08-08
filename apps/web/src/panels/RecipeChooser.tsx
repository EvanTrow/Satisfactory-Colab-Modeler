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
// Redesign pass (Steam-app-inspired "Add a machine" layout): the left rail
// now carries the special, non-recipe node types (Outpost/Blueprint/
// Splurger, plus a disabled "more buildings" placeholder for node kinds
// this app doesn't build yet) as icon buttons, ABOVE the existing
// per-machine filter list — previously these lived as small text buttons in
// the header. The search box now matches name/inputs/outputs together (each
// independently toggleable — see `recipeChooser/filters.ts`'s
// `RecipeChooserFilters`), and each recipe row shows real part icons
// (inputs left, outputs right) around a centered name, instead of a plain
// text row.
//
// Later pass: Priority Splitter/Merger/Splurger (three cosmetic entry
// points into the same `kind: "splurger"` node as the plain "Splurger"
// button — see `createSplurgerVariant`), AWESOME Sink, Dimensional Depot
// Uploader, and Storage Container (three new real node kinds — see
// `../canvas/nodes/SinkNode.tsx`/`StorageNode.tsx` and
// `../workers/sinkPassthrough.ts`/`storagePassthrough.ts` for how they
// participate in a solve despite having no real `@scm/gamedata` recipe).
//
// New in this pass: `pendingConnection` — when a connection is dragged out
// from a port and released on empty canvas (`CanvasView.tsx`'s
// `onConnectEnd` wiring), this chooser opens pre-filtered to recipes that
// could plug into that dangling port (`initialFiltersForPendingPart`), and
// auto-connects the dragged-from port to the newly created node's matching
// port (`matchingHandleId` for a recipe node, `WILDCARD_PART` for a
// Splurger) the moment it's created.
import { ArrowLeft, ArrowLeftRight, Boxes, FlaskConical, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";

import {
  defaultGameData,
  defaultVariant,
  resolveMachine,
  type Recipe,
  type ResolvedMultiMachine,
} from "@scm/gamedata";
import { isNegative } from "@scm/rational";
import { addContainer, addNode, splurgerPortCaps, type SplurgerVariant } from "@scm/ydoc";

import { useFocusTrap } from "../a11y";
import { getBlueprintIconUrl, getIconUrl, getOutpostIconUrl } from "../assets/icons";
import { useCanvasDoc } from "../canvas";
import { connectPorts, WILDCARD_PART, WILDCARD_PART_TOP, type ConnectionLike } from "../canvas/edges";
import { useSettings } from "../canvas/useSettings";
import { useGameTerm } from "../i18n";
import {
  EMPTY_RECIPE_FILTERS,
  buildNodeInputForRecipe,
  filterRecipes,
  initialFiltersForPendingPart,
  listChooserMachines,
  listChooserTiers,
  matchingHandleId,
  type RecipeChooserFilters,
  type RecipeProgressionFilter,
  type RecipeVariantChoice,
} from "./recipeChooser/filters";

/** The dragged-from port of a connection released on empty canvas — see this file's header comment. `direction`/`part` are `edges/connectionLogic.ts`'s `parsePortHandleId` output for `handleId`. */
export interface PendingConnectionInfo {
  nodeId: string;
  handleId: string;
  direction: "in" | "out";
  part: string;
}

export interface RecipeChooserProps {
  /** Where (React Flow / document coordinates) the created node should be placed — the point the user double/right-clicked, or where a dragged connection was released. */
  flowPosition: { x: number; y: number };
  /** Where (viewport/screen coordinates) to anchor the modal, so it opens "at that point" per PLAN.md §2. */
  screenPosition: { x: number; y: number };
  /** Set when this chooser was opened by dragging a connection out to empty canvas rather than a double/right-click — see this file's header comment. */
  pendingConnection?: PendingConnectionInfo | null;
  /** Called after a successful `addNode`, and also when the user closes without selecting (Escape / click-outside / the ✕ button) — callers can't tell the two apart from this alone, which matches the job's "closing without selecting does nothing" requirement (nothing extra needs to run either way). */
  onClose: () => void;
}

const MODAL_WIDTH = 760;
const MODAL_HEIGHT = 520;
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

export function RecipeChooser({ flowPosition, screenPosition, pendingConnection, onClose }: RecipeChooserProps) {
  const { t } = useTranslation("app");
  const { t: tRaw } = useTranslation();
  const gameTerm = useGameTerm();
  const { sfmDoc, containerId } = useCanvasDoc();
  const gameData = defaultGameData;
  // Project-wide progression gate (`Settings.recipeTierFilter`/
  // `recipePhaseFilter`, set via `SettingsMenu.tsx`) — defaults to "none"
  // (both null), which `filterRecipes` treats as no additional filtering.
  const settings = useSettings(sfmDoc);
  const progression: RecipeProgressionFilter = useMemo(
    () => ({ tier: settings.recipeTierFilter, phase: settings.recipePhaseFilter }),
    [settings.recipeTierFilter, settings.recipePhaseFilter],
  );

  // A connection dragged out and released here opens pre-filtered to
  // recipes that could plug into it — see `initialFiltersForPendingPart`'s
  // own doc comment. `pendingConnection` never changes across this
  // component's lifetime (a fresh instance mounts per chooser open, see
  // `CanvasView.tsx`'s `{chooser && <RecipeChooser .../>}`), so a lazy
  // initializer is enough — no effect needed to keep it in sync.
  const [filters, setFilters] = useState<RecipeChooserFilters>(() =>
    pendingConnection
      ? initialFiltersForPendingPart(pendingConnection.direction, pendingConnection.part)
      : EMPTY_RECIPE_FILTERS,
  );
  // Set only for a MultiMachine-backed recipe, while its variant picker is showing.
  const [pendingRecipe, setPendingRecipe] = useState<Recipe | null>(null);
  const [variantChoice, setVariantChoice] = useState<RecipeVariantChoice>({});
  // Job 013: "New Outpost" is the second thing this same double/right-click
  // gesture can create, alongside a recipe node — see PLAN.md §2's Outposts
  // row ("like folders") and this job's Scope wording ("e.g. via the Recipe
  // Chooser's canvas context menu... use judgement on exact entry point").
  // A third mutually-exclusive step, same shape as `pendingRecipe`'s
  // variant-picker step below. `creatingBlueprint` is the same shape again,
  // for this redesign's new direct "+ Blueprint" sidebar button (blueprints
  // were previously only reachable by converting an existing outpost via
  // the node context menu).
  const [creatingOutpost, setCreatingOutpost] = useState(false);
  const [creatingBlueprint, setCreatingBlueprint] = useState(false);
  // Job 028: the default title text is translated at creation time (the
  // active locale when the outpost/Splurger is placed) — it's ordinary,
  // renamable document content afterward (`Container.title`/`NodeRecord
  // .title`, a plain CRDT string), not a live-relocalized UI label, so it
  // deliberately does NOT re-translate if the viewer later switches locale
  // — same one-time-default behavior as e.g. a word processor's "Untitled
  // Document" seed text.
  const [outpostTitle, setOutpostTitle] = useState(() => t("canvas.defaultOutpostTitle"));
  const [blueprintTitle, setBlueprintTitle] = useState(() => t("canvas.defaultBlueprintTitle"));

  // Job 029: focus trap — see `a11y/useFocusTrap.ts`'s header for why this
  // (a true modal, unlike the other three panels below) needs it just as
  // much as they do. `modalRef` is the same element the `role="dialog"`/
  // `aria-modal` attributes below go on. `searchInputRef` is passed as the
  // trap's `initialFocusRef` so the search box (which already had its own
  // `autoFocus` since Job 009) keeps that focus rather than the trap's
  // default "focus the first focusable descendant" picking a sidebar button
  // instead, since those sit earlier in the DOM — confirmed live to be a
  // real regression before this fix (opening the chooser landed keyboard
  // focus on "+ New Outpost", not the search box).
  const modalRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(modalRef, true, { onClose, initialFocusRef: searchInputRef });

  const machines = useMemo(() => listChooserMachines(gameData), [gameData]);
  const tiers = useMemo(() => listChooserTiers(gameData), [gameData]);
  const recipes = useMemo(
    () => filterRecipes(gameData, filters, progression),
    [gameData, filters, progression],
  );

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

  /**
   * Connects `pendingConnection`'s dragged-from port to `newHandleId` on the
   * just-created `newNodeId` — a no-op when this chooser wasn't opened via a
   * connection drag. Direction determines which side is `source`/`target`:
   * a drag from an OUTPUT means the new node's port is the connection's
   * `target` (something to consume it), and vice versa. Reuses
   * `connectPorts` (the same function `useConnectionHandlers.ts` calls for
   * an ordinary drag-to-drag connection) so this gets the identical
   * part-reconciliation rules for free.
   */
  function autoConnectPending(newNodeId: string, newHandleId: string) {
    if (!pendingConnection) return;
    const connection: ConnectionLike =
      pendingConnection.direction === "out"
        ? {
            source: pendingConnection.nodeId,
            sourceHandle: pendingConnection.handleId,
            target: newNodeId,
            targetHandle: newHandleId,
          }
        : {
            source: newNodeId,
            sourceHandle: newHandleId,
            target: pendingConnection.nodeId,
            targetHandle: pendingConnection.handleId,
          };
    connectPorts(sfmDoc, containerId, connection);
  }

  function createNode(recipe: Recipe, choice?: RecipeVariantChoice) {
    const input = buildNodeInputForRecipe({
      gameData,
      recipe,
      containerId,
      position: flowPosition,
      variantChoice: choice,
    });
    const node = addNode(sfmDoc, input);
    // Only auto-connects if this exact recipe actually has a part matching
    // the dragged-from one — the user may have widened the filters (or
    // typed over the pre-filled search) and picked something unrelated, in
    // which case placing the node with no connection is the right outcome,
    // not a mismatched-part edge or a thrown error.
    if (pendingConnection) {
      const handleId = matchingHandleId(recipe, pendingConnection);
      if (handleId) autoConnectPending(node.id, handleId);
    }
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
   * Direct blueprint creation — previously blueprints were only reachable
   * by converting an existing outpost (`NodeContextMenu.tsx`'s
   * `onConvertContainerKind`, still there and unchanged). Mirrors
   * `handleCreateOutpost` exactly; a container has no ports, so there's no
   * `autoConnectPending` call here even when `pendingConnection` is set —
   * dragging a connection out and choosing "Blueprint" just places it,
   * same as choosing "Outpost" would.
   */
  function handleCreateBlueprint() {
    addContainer(sfmDoc, {
      kind: "blueprint",
      parentId: containerId,
      title: blueprintTitle.trim() || t("canvas.defaultBlueprintTitle"),
      color: "#0a6b62",
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
   * Splitter, Priority Merger, and Priority Splurger — which one it *reads*
   * as is purely a function of how it ends up wired (see `SplurgerNode.tsx`'s
   * header for why that's the right call, matching real splitter/merger
   * hardware's own "never both multi-in and multi-out" shape). The three
   * Priority variants are purely cosmetic entry points into this SAME
   * function — different default `title`, same node — since the underlying
   * node already has full two-tier priority controls regardless of which
   * button placed it (the priority aspect only actually affects Full mode's
   * solve — see `@scm/solver`'s `SolverEdge.priorityTier`).
   */
  function createSplurgerVariant(variant: SplurgerVariant, title: string) {
    const node = addNode(sfmDoc, {
      containerId,
      kind: "splurger",
      recipe: null,
      machine: null,
      x: flowPosition.x,
      y: flowPosition.y,
      title,
      color: "#7c3aed",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: variant,
    });
    // A Splurger's handles are wildcards — they reconcile against any real
    // part, so unlike a recipe node there's no "does this actually have a
    // matching port" check needed here. Which handle id actually exists
    // depends on `variant`'s own port caps (`SplurgerNode.tsx`'s tiered
    // sides render `*top`/`*bottom`, not the plain wildcard) — a fresh
    // auto-connected wire defaults to the top tier on a tiered side, same as
    // any other newly-made connection would.
    if (pendingConnection) {
      const caps = splurgerPortCaps(variant);
      const side = pendingConnection.direction === "out" ? "in" : "out";
      const sentinel = (side === "in" ? caps.in : caps.out) === 2 ? WILDCARD_PART_TOP : WILDCARD_PART;
      autoConnectPending(node.id, `${side}:${sentinel}`);
    }
    onClose();
  }

  function handleCreateSplurger() {
    createSplurgerVariant("splurger", gameTerm("Splurger"));
  }

  /**
   * AWESOME Sink / Dimensional Depot Uploader — terminal, input-only node
   * kinds (`kind: "sink"`/`"depot"`). `machine` is set to the real
   * `@scm/gamedata` `Machines` name (both exist there — see
   * `packages/gamedata/src/machines.ts`'s own note that neither is ever a
   * recipe's `Machine` field) purely so cost-to-build/icon lookups resolve
   * for free later; the solver never resolves this node via that name (see
   * `workers/sinkPassthrough.ts`). `limitMode` is always `"ppm"` — there's
   * no "machine count" concept for a sink, matching PLAN.md §2's "Miners
   * and AWESOME Sinks default to parts-per-minute."
   */
  function createSinkOrDepot(kind: "sink" | "depot", machine: string, title: string) {
    const node = addNode(sfmDoc, {
      containerId,
      kind,
      recipe: null,
      machine,
      x: flowPosition.x,
      y: flowPosition.y,
      title,
      color: "#7c3aed",
      limit: null,
      limitMode: "ppm",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });
    if (pendingConnection && pendingConnection.direction === "out") {
      autoConnectPending(node.id, `in:${WILDCARD_PART}`);
    }
    onClose();
  }

  function handleCreateSink() {
    createSinkOrDepot("sink", "AWESOME Sink", "AWESOME Sink");
  }

  function handleCreateDepot() {
    createSinkOrDepot("depot", "Dimensional Depot Uploader", "Dimensional Depot");
  }

  /**
   * Storage Container (`kind: "storage"`) — unlike Sink/Depot, not a real
   * `@scm/gamedata` `Machines` entry, so `machine` stays `null` and its icon
   * is looked up by the literal string `"Storage Container"` instead (see
   * `canvas/nodes/StorageNode.tsx`). Defaults to the `"partiallyFull"`
   * `storageMode` — see `workers/storagePassthrough.ts`'s header for which
   * of the four modes actually has solver behavior right now.
   */
  function handleCreateStorage() {
    const node = addNode(sfmDoc, {
      containerId,
      kind: "storage",
      recipe: null,
      machine: null,
      x: flowPosition.x,
      y: flowPosition.y,
      title: "Storage Container",
      color: "#7c3aed",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: "partiallyFull",
      splurgerVariant: null,
    });
    if (pendingConnection) {
      const handleId = pendingConnection.direction === "out" ? `in:${WILDCARD_PART}` : `out:${WILDCARD_PART}`;
      autoConnectPending(node.id, handleId);
    }
    onClose();
  }

  function handlePickRecipe(recipe: Recipe) {
    const resolved = resolveMachine(recipe.machine, gameData);
    // Miner is the only MultiMachine family with a model (Mk.) dimension —
    // it's deliberately flattened to always place at its default variant
    // (Mk.1 x Normal, ratio 1 -> the game's base 60/min rate) with no
    // picker step at all. A Miner's ppm is meant to be a single freely
    // typed number on the node afterward (like the Steam app), not a
    // building-tier choice made once at creation time.
    if (resolved.kind === "machine" || resolved.name === "Miner") {
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
  const heading = creatingOutpost
    ? t("canvas.newOutpostHeading")
    : creatingBlueprint
      ? t("canvas.newBlueprintHeading")
      : t("canvas.addMachine");

  return (
    // Backdrop: clicking outside the modal box closes without selecting.
    <div className="fixed inset-0 z-50 bg-black/20" onMouseDown={onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="absolute flex flex-col overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-primary)] shadow-[var(--shadow-modal)]"
        style={{ left: modalPosition.left, top: modalPosition.top, width: MODAL_WIDTH, height: MODAL_HEIGHT }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2">
          <h3 className="text-sm font-semibold">{heading}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("canvas.close")}
            className="rounded-md px-1.5 py-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
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
                <ArrowLeft className="inline h-3.5 w-3.5" aria-hidden /> {t("canvas.back")}
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
        ) : creatingBlueprint ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
              {t("canvas.blueprintName")}
              <input
                type="text"
                autoFocus
                value={blueprintTitle}
                onChange={(event) => setBlueprintTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleCreateBlueprint();
                }}
                className="rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 py-1 text-[var(--text-primary)] focus:border-[var(--blueprint)] focus:outline-none"
              />
            </label>
            <div className="mt-auto flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreatingBlueprint(false)}
                className="rounded-md px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <ArrowLeft className="inline h-3.5 w-3.5" aria-hidden /> {t("canvas.back")}
              </button>
              <button
                type="button"
                onClick={handleCreateBlueprint}
                className="rounded-md bg-[var(--blueprint)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast)] hover:brightness-110"
              >
                {t("canvas.createBlueprint")}
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
            {/*
              Left rail: the special, non-recipe node types (Steam-inspired
              "Add a building" sidebar) above the existing per-machine
              filter list. "More buildings" stays disabled — Space Elevator
              phases and the Any-Part wildcard (PLAN.md §2) still have no
              node kind behind them.
            */}
            <div className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-[var(--border-subtle)] p-2">
              <div className="grid grid-cols-2 gap-1.5">
                <SidebarButton
                  label={tRaw("Outpost")}
                  title={t("canvas.newOutpostTitle")}
                  iconUrl={getOutpostIconUrl()}
                  swatchClassName="bg-[var(--outpost-soft)]"
                  onClick={() => setCreatingOutpost(true)}
                />
                <SidebarButton
                  label={tRaw("Blueprint")}
                  title={t("canvas.newBlueprintTitle")}
                  iconUrl={getBlueprintIconUrl()}
                  swatchClassName="bg-[var(--blueprint-soft)]"
                  onClick={() => setCreatingBlueprint(true)}
                />
                <SidebarButton
                  label={tRaw("Splurger")}
                  title={t("canvas.newSplurgerTitle")}
                  icon={<ArrowLeftRight className="h-4 w-4 text-[var(--splurger)]" aria-hidden />}
                  swatchClassName="bg-[var(--splurger-soft)]"
                  onClick={handleCreateSplurger}
                />
                <SidebarButton
                  label="Priority Splitter"
                  title={t("canvas.newPrioritySplitterTitle")}
                  iconUrl={getIconUrl("Smart Splitter")}
                  swatchClassName="bg-[var(--splurger-soft)]"
                  onClick={() => createSplurgerVariant("splitter", "Priority Splitter")}
                />
                <SidebarButton
                  label="Priority Merger"
                  title={t("canvas.newPriorityMergerTitle")}
                  iconUrl={getIconUrl("Conveyor Merger")}
                  swatchClassName="bg-[var(--splurger-soft)]"
                  onClick={() => createSplurgerVariant("merger", "Priority Merger")}
                />
                <SidebarButton
                  label="Priority Splurger"
                  title={t("canvas.newPrioritySplurgerTitle")}
                  icon={<ArrowLeftRight className="h-4 w-4 text-[var(--splurger)]" aria-hidden />}
                  swatchClassName="bg-[var(--splurger-soft)]"
                  onClick={() => createSplurgerVariant("prioritySplurger", "Priority Splurger")}
                />
                <SidebarButton
                  label="AWESOME Sink"
                  title={t("canvas.newSinkTitle")}
                  iconUrl={getIconUrl("AWESOME Sink")}
                  swatchClassName="bg-[var(--splurger-soft)]"
                  onClick={handleCreateSink}
                />
                <SidebarButton
                  label="Storage Container"
                  title={t("canvas.newStorageTitle")}
                  iconUrl={getIconUrl("Storage Container")}
                  swatchClassName="bg-[var(--splurger-soft)]"
                  onClick={handleCreateStorage}
                />
                <SidebarButton
                  label="Dimensional Depot"
                  title={t("canvas.newDepotTitle")}
                  iconUrl={getIconUrl("Dimensional Depot Uploader")}
                  swatchClassName="bg-[var(--splurger-soft)]"
                  onClick={handleCreateDepot}
                />
                <SidebarButton
                  label={t("canvas.otherBuildings")}
                  title={t("canvas.comingSoon")}
                  icon={<Boxes className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />}
                  swatchClassName="bg-[var(--surface-sunken)]"
                  disabled
                />
              </div>

              <p className="mb-1 mt-3 border-t border-[var(--border-subtle)] px-1 pt-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
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
              <div className="flex flex-col gap-1.5 border-b border-[var(--border-subtle)] p-2">
                <div className="flex flex-wrap items-center gap-2">
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
                {/*
                  Job (Add-a-machine redesign): the three search-field
                  switches — "Search should filter by recipe name, inputs &
                  outputs [with] switches to enable or disable" each
                  independently. See `filters.ts`'s `RecipeChooserFilters`
                  for the OR-composition these drive.
                */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                    {t("canvas.searchIn")}
                  </span>
                  <FilterToggleChip
                    label={t("canvas.searchByName")}
                    title={t("canvas.searchByNameTitle")}
                    active={filters.searchByName}
                    onClick={() => setFilters((f) => ({ ...f, searchByName: !f.searchByName }))}
                  />
                  <FilterToggleChip
                    label={t("canvas.searchByInputs")}
                    title={t("canvas.searchByInputsTitle")}
                    active={filters.searchByInputs}
                    onClick={() => setFilters((f) => ({ ...f, searchByInputs: !f.searchByInputs }))}
                  />
                  <FilterToggleChip
                    label={t("canvas.searchByOutputs")}
                    title={t("canvas.searchByOutputsTitle")}
                    active={filters.searchByOutputs}
                    onClick={() => setFilters((f) => ({ ...f, searchByOutputs: !f.searchByOutputs }))}
                  />
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
                {recipes.length === 0 && (
                  <p className="p-3 text-sm text-[var(--text-muted)]">{t("canvas.noRecipesMatch")}</p>
                )}
                {recipes.map((recipe) => (
                  <RecipeRow key={recipe.name} recipe={recipe} onClick={() => handlePickRecipe(recipe)} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface SidebarButtonProps {
  label: string;
  title: string;
  /** A real game-art icon (Outpost/Blueprint) — takes priority over `icon` when both would apply. */
  iconUrl?: string;
  /** A lucide icon, for node kinds with no dedicated art asset (Splurger, and the two disabled placeholders). */
  icon?: ReactNode;
  /**
   * A full, static Tailwind class string for the icon swatch's background —
   * NOT built from a template literal at the call site, since Tailwind's
   * build-time scanner can't see a class name assembled from an
   * interpolated variable (confirmed against this repo's existing
   * `--outpost-soft`/`--splurger-soft`-style literal classes elsewhere,
   * e.g. `RecipeChooser`'s own pre-redesign header buttons).
   */
  swatchClassName: string;
  disabled?: boolean;
  onClick?: () => void;
}

/** One left-rail "add this instead of a recipe" button — Outpost/Blueprint/Splurger/Storage/other buildings. See this file's header comment for why Storage and "other buildings" are always `disabled`. */
function SidebarButton({ label, title, iconUrl, icon, swatchClassName, disabled, onClick }: SidebarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-md border px-1.5 py-2 text-center transition-colors ${
        disabled
          ? "cursor-not-allowed border-[var(--border-subtle)] opacity-50"
          : "border-[var(--border-default)] bg-[var(--surface-panel)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
      }`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${swatchClassName}`}
        aria-hidden
      >
        {iconUrl ? <img src={iconUrl} alt="" className="h-6 w-6 object-contain" /> : icon}
      </span>
      <span className="w-full truncate text-[10px] text-[var(--text-secondary)]">{label}</span>
    </button>
  );
}

interface FilterToggleChipProps {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}

/** One of the search box's three name/inputs/outputs switches. */
function FilterToggleChip({ label, title, active, onClick }: FilterToggleChipProps) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
        active
          ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
          : "border-[var(--border-default)] bg-[var(--surface-sunken)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      }`}
    >
      {label}
    </button>
  );
}

/** A single part's icon (or a blank placeholder swatch when no icon file exists — see `assets/icons.ts`'s `getIconUrl` doc comment), title-tooltipped with its translated name. */
function PartIcon({ part }: { part: string }) {
  const gameTerm = useGameTerm();
  const iconUrl = getIconUrl(part);
  const label = gameTerm(part);
  return iconUrl ? (
    <img
      src={iconUrl}
      alt=""
      title={label}
      className="h-5 w-5 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5"
    />
  ) : (
    <span title={label} className="h-5 w-5 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
  );
}

interface RecipeRowProps {
  recipe: Recipe;
  onClick: () => void;
}

/**
 * One recipe list row — Steam-inspired layout: input part icons at the FAR
 * left edge, centered name (+machine/tier subtext), output part icons at
 * the FAR right edge (previously these hugged the centered name instead —
 * `justify-end`/`justify-start` were backwards for a `1fr` column sitting
 * on the left/right of a grid: "end" of the LEFT column is its right
 * side, next to center, not the row's own left edge). An alternate
 * recipe gets a small flask badge next to its name plus a tinted row
 * background (`--alt-recipe-soft`) so it reads as visually distinct from a
 * standard recipe at a glance, Steam-app-inspired (its own alternate rows
 * get the same blue-highlight treatment) — replaces the plain
 * "· Alternate Recipe" text suffix this row used to append to the subtext
 * line.
 */
function RecipeRow({ recipe, onClick }: RecipeRowProps) {
  const { t } = useTranslation("app");
  const gameTerm = useGameTerm();
  const inputs = recipe.parts.filter((p) => isNegative(p.amount));
  const outputs = recipe.parts.filter((p) => !isNegative(p.amount));
  const alternateLabel = t("ALTERNATE_RECIPE", { ns: "translation" });

  return (
    <button
      type="button"
      onClick={onClick}
      title={recipe.alternate ? alternateLabel : undefined}
      className={`grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-md border px-2 py-2 transition-colors ${
        recipe.alternate
          ? "border-[var(--alt-recipe-border)] bg-[var(--alt-recipe-soft)] hover:brightness-110"
          : "border-transparent hover:bg-[var(--surface-hover)]"
      }`}
    >
      <div className="flex flex-wrap items-center justify-start gap-1">
        {inputs.map((part) => (
          <PartIcon key={part.part} part={part.part} />
        ))}
      </div>
      <div className="flex min-w-0 flex-col items-center text-center">
        <span className="flex max-w-[11rem] items-center gap-1">
          {recipe.alternate && (
            <FlaskConical className="h-3 w-3 shrink-0 text-[var(--alt-recipe)]" aria-hidden />
          )}
          <span className="truncate text-sm text-[var(--text-primary)]">{gameTerm(recipe.name)}</span>
        </span>
        <span className="max-w-[11rem] truncate text-[10px] text-[var(--text-muted)]">
          {gameTerm(recipe.machine)} · {recipe.tier.raw}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        {outputs.map((part) => (
          <PartIcon key={part.part} part={part.part} />
        ))}
      </div>
    </button>
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
          <ArrowLeft className="inline h-3.5 w-3.5" aria-hidden /> {t("canvas.back")}
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
