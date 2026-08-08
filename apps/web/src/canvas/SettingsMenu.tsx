// Job 014: the minimal settings surface this job's own acceptance criteria
// requires — "disabling the setting restores free positioning" implies
// there has to be *some* UI path to disable `Settings.snapMachines`/
// `snapWaypoints`, and nothing before this job built one (Job 007 only
// defined the schema; every job since left the fields unused — see
// `useYjsSync.ts`'s `onNodeDragStop` and `edges/ConnectionEdge.tsx`'s
// waypoint-commit handler for where they're finally read). Deliberately
// narrow: two checkboxes bound straight to `@scm/ydoc`'s `updateSettings`,
// nothing else — a fuller settings panel (number formats, connection style,
// multipliers) is explicitly out of this job's scope (PLAN.md's later-phase
// concerns), and building a bigger surface here would be scope creep past
// "no new functional behavior beyond snap-to-grid."
//
// Job 019 added the two sections Job 018's own Handoff notes flagged as
// missing UI: a solver-mode selector (`Settings.solverMode` — Job 018
// verified Basic mode by setting it via the browser console, since no UI
// existed) and the number-format controls PLAN.md §3 asks for ("fraction/
// decimal, digits, rounding"). Both are still plain `updateSettings` calls,
// same mechanism as the pre-existing checkboxes — no new state-management
// pattern introduced.
//
// Job 024 widens the mode selector to include Full, now that `@scm/solver`
// actually implements it (Job 023) and the worker host actually dispatches
// it (Job 018/024's `solveScheduler.ts`/`useSolver.ts`) — see
// `SOLVER_MODES` below.
import { Settings as SettingsIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { updateSettings, type NumberFormats, type Settings, type SolverMode } from "@scm/ydoc";

import type { SfmDocument } from "@scm/ydoc";

import { useFocusTrap } from "../a11y";
import { PROGRESSION_PHASES, isValidProgressionSelection } from "../panels/recipeChooser/progression";
import { CONNECTION_STYLE_OPTIONS } from "./edges";

export interface SettingsMenuProps {
  sfmDoc: SfmDocument;
  settings: Settings;
}

const rowClass =
  "flex items-center justify-between gap-3 px-1 py-1 text-sm text-[var(--text-secondary)]";
const selectClass =
  "nodrag rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none";

/**
 * PLAN.md §2's table names four modes (Full/Basic/Manual/None). Full is now
 * real end to end — `@scm/solver`'s `solveFull` (Job 023), dispatched by
 * `solveScheduler.ts`'s widened `SUPPORTED_MODES` and `useSolver.ts`'s
 * resync (Job 024) — so it's offered here alongside the other three.
 *
 * These reuse the original tool's own `*_SOLVER` keys (`en-US.json`) — just
 * the bare mode name ("Basic"), not the longer inline description this
 * dropdown used to inline into the option text itself. That longer text
 * (`*_SOLVER_HELP`) made the widest option ("Full (limits + even-split &
 * priority routing)") wider than the settings popover, so it rendered
 * overflowing the panel's right edge. It's still available, just as the
 * select's `title` below rather than crammed into the visible label.
 */
const SOLVER_MODES: readonly { value: SolverMode; labelKey: string; helpKey: string }[] = [
  { value: "none", labelKey: "NONE_SOLVER", helpKey: "NONE_SOLVER_HELP" },
  { value: "manual", labelKey: "MANUAL_SOLVER", helpKey: "MANUAL_SOLVER_HELP" },
  { value: "basic", labelKey: "BASIC_SOLVER", helpKey: "BASIC_SOLVER_HELP" },
  { value: "full", labelKey: "FULL_SOLVER", helpKey: "FULL_SOLVER_HELP" },
];

const NUMBER_FORMAT_STYLES: readonly { value: NumberFormats["style"]; labelKey: string }[] = [
  { value: "fraction", labelKey: "settings.numberFormatStyle.fraction" },
  { value: "mixed", labelKey: "settings.numberFormatStyle.mixed" },
  { value: "decimal", labelKey: "settings.numberFormatStyle.decimal" },
];

/**
 * Job 028: the original's own rounding-mode vocabulary (per
 * `NUMBER_SETTINGS_HELP`'s exact wording) is a 3-way "Nearest"/"Up"/"Down"
 * choice, not this schema's 4-way `round`/`floor`/`ceil`/`truncate` — two of
 * the four have a clean, precise reuse:
 *   - `round` -> `NEAREST` ("Nearest") — `NUMBER_SETTINGS_HELP` literally
 *     defines it as "standard rounding, round the last digit up if the next
 *     digit is 5 or more," which is exactly `toDecimalString`'s `"round"`
 *     mode (round half away from zero).
 *   - `truncate` -> `DOWN` ("Down") — same help text: "'Down' truncates to
 *     the last digit," exactly matching `"truncate"`'s own doc comment
 *     (round toward zero).
 * `floor`/`ceil` are directional (toward -/+ infinity) where the original's
 * one remaining option, "Up" ("rounds the last digit up if there are any
 * more digits after it"), is magnitude-based (away from zero regardless of
 * sign) — genuinely a different concept from either, so reusing "Up" for
 * just one of them would misrepresent the other. Both stay new `app` keys.
 */
const ROUNDING_MODES: readonly { value: NumberFormats["rounding"]; labelKey: string; ns?: "translation" }[] = [
  { value: "round", labelKey: "NEAREST", ns: "translation" },
  { value: "floor", labelKey: "settings.roundingMode.floor" },
  { value: "ceil", labelKey: "settings.roundingMode.ceil" },
  { value: "truncate", labelKey: "DOWN", ns: "translation" },
];

/** Tier `0`-`9` — the game's fixed range (every `Tier.raw` is `"0-0"`…`"9-5"`, see `@scm/gamedata`'s `indices.ts`). */
const PROGRESSION_TIERS: readonly number[] = Array.from({ length: 10 }, (_, i) => i);

export function SettingsMenu({ sfmDoc, settings }: SettingsMenuProps) {
  const { t } = useTranslation("app");
  // Job 028: `tRaw` reaches into the default `translation` namespace for
  // every label below that reuses one of the original string table's own
  // keys verbatim — `SETTINGS`/`LANGUAGE`/`DIGITS`/`ROUND`/`MACHINES`/
  // `STYLE`/`NUMBER_SETTINGS`, plus `CONNECTION_STYLE_OPTIONS`'s own
  // `DIRECT`/`CURVES`/`HORIZONTAL`/`VERTICAL` keys.
  const { t: tRaw } = useTranslation();
  const [open, setOpen] = useState(false);
  // Job 029: focus trap while the popover is open — see
  // `a11y/useFocusTrap.ts`'s header comment; this panel is one of the three
  // toolbar dropdowns sharing its exact shape (`SharingPanel`/`VersionPanel`
  // are the other two).
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open, { onClose: () => setOpen(false) });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={tRaw("SETTINGS")}
        aria-label={tRaw("SETTINGS")}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="nodrag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
      >
        <SettingsIcon className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={tRaw("SETTINGS")}
            className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-2 shadow-[var(--shadow-modal)]"
            // Same backdrop-vs-content mousedown-ordering fix
            // `RecipeChooser.tsx`/`NodeContextMenu.tsx` already apply: without
            // this, the backdrop's own `onMouseDown` (which closes the menu)
            // fires and unmounts this panel *before* a checkbox click's
            // `onChange` gets a chance to run, since `mousedown` fires before
            // `click` and this panel sits inside the same bubble path as the
            // backdrop behind it. Confirmed via this job's own manual browser
            // verification — the checkboxes were completely unclickable
            // without this line.
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p className="mb-1 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {t("settings.snapToGrid")}
            </p>
            <label className={rowClass}>
              <span>
                {tRaw("MACHINES")}
                <span className="ml-1 text-[var(--text-muted)]">
                  ({settings.gridMachine.x}×{settings.gridMachine.y}px)
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.snapMachines}
                onChange={(event) => updateSettings(sfmDoc, { snapMachines: event.target.checked })}
                className="accent-[var(--accent)]"
              />
            </label>
            <label className={rowClass}>
              <span>
                {t("settings.waypoints")}
                <span className="ml-1 text-[var(--text-muted)]">
                  ({settings.gridWaypoint.x}×{settings.gridWaypoint.y}px)
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.snapWaypoints}
                onChange={(event) =>
                  updateSettings(sfmDoc, { snapWaypoints: event.target.checked })
                }
                className="accent-[var(--accent)]"
              />
            </label>

            {/*
              Job 019: `Settings.solverMode` selector — Job 018 built the
              worker host but explicitly left this UI for this job (its own
              Handoff notes: "no UI exists yet to change Settings.solverMode
              ... verified Basic mode by setting it via the console"). A
              single `updateSettings` call, same mechanism as the checkboxes
              above.
            */}
            <p className="mb-1 mt-3 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {t("settings.calculator")}
            </p>
            <label className={rowClass}>
              <span>{t("settings.mode")}</span>
              <select
                className={selectClass}
                value={settings.solverMode}
                title={tRaw(
                  SOLVER_MODES.find((mode) => mode.value === settings.solverMode)?.helpKey ??
                    "SOLVER_HELP",
                )}
                onChange={(event) =>
                  updateSettings(sfmDoc, { solverMode: event.target.value as SolverMode })
                }
              >
                {SOLVER_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value} title={tRaw(mode.helpKey)}>
                    {tRaw(mode.labelKey)}
                  </option>
                ))}
              </select>
            </label>

            {/*
              Job 027: `Settings.connectionStyle` — the document-wide
              default connection rendering (PLAN.md §3's later-phase
              "connection style options"). PLAN.md's own UI copy
              (Direct/Curves/Horizontal) differs from the schema's
              React-Flow-native enum (straight/bezier/step) — see
              `edges/connectionStyle.ts`'s header for the full reconciliation
              this job commits to; `CONNECTION_STYLE_OPTIONS` is the single
              place that mapping lives, so this dropdown and
              `ConnectionEdge.tsx`'s actual rendering can never drift apart.
              A per-edge override (`EdgeRecord.style`) also exists and takes
              precedence over this default when set, but has no UI of its
              own yet — see this job's Handoff notes.
            */}
            <p className="mb-1 mt-3 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {t("settings.connections")}
            </p>
            <label className={rowClass}>
              <span>{tRaw("STYLE")}</span>
              <select
                className={selectClass}
                value={settings.connectionStyle}
                onChange={(event) =>
                  updateSettings(sfmDoc, {
                    connectionStyle: event.target.value as Settings["connectionStyle"],
                  })
                }
              >
                {CONNECTION_STYLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {tRaw(option.labelKey)}
                  </option>
                ))}
              </select>
            </label>

            {/*
              Adds a project-wide progression gate for the Recipe Chooser
              search (`Settings.recipeTierFilter`/`recipePhaseFilter`) —
              defaults to "None" on both, which does nothing (all recipes
              show, same as today). When set, only recipes available by that
              Tier and/or Space Elevator phase are shown — see
              `recipeChooser/filters.ts`'s `RecipeProgressionFilter` for the
              cumulative (`<=`) semantics and how the two AND together.

              Each dropdown disables the options the OTHER field's current
              value rules out — e.g. with Phase 1 selected (which only
              unlocks Tiers 3-4 per `progression.ts`'s delivery-unlock
              table), Tier 5-9 become unpickable here, and picking Tier 9 in
              the other dropdown would likewise disable Phase 1-3. "None" is
              never disabled on either side — an unset axis imposes no
              constraint, so it's always a valid choice. This is UI-level
              only (no auto-correction of an already-set value): a
              same-instant edit from a different collaborator could still
              land the two fields on an incompatible pair, but
              `progressionMaxTier` in `filters.ts` degrades gracefully for
              that case (see its own doc comment).
            */}
            <p className="mb-1 mt-3 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {t("settings.progression")}
            </p>
            <label className={rowClass}>
              <span>{t("settings.progressionTier")}</span>
              <select
                className={selectClass}
                value={settings.recipeTierFilter ?? ""}
                onChange={(event) =>
                  updateSettings(sfmDoc, {
                    recipeTierFilter: event.target.value === "" ? null : Number(event.target.value),
                  })
                }
              >
                <option value="">{t("settings.progressionNone")}</option>
                {PROGRESSION_TIERS.map((tier) => (
                  <option
                    key={tier}
                    value={tier}
                    disabled={!isValidProgressionSelection(tier, settings.recipePhaseFilter)}
                  >
                    {t("settings.progressionTierOption", { tier })}
                  </option>
                ))}
              </select>
            </label>
            <label className={rowClass}>
              <span>{t("settings.progressionPhase")}</span>
              <select
                className={selectClass}
                value={settings.recipePhaseFilter ?? ""}
                onChange={(event) =>
                  updateSettings(sfmDoc, {
                    recipePhaseFilter: event.target.value === "" ? null : Number(event.target.value),
                  })
                }
              >
                <option value="">{t("settings.progressionNone")}</option>
                {PROGRESSION_PHASES.map((phase) => (
                  <option
                    key={phase}
                    value={phase}
                    disabled={!isValidProgressionSelection(settings.recipeTierFilter, phase)}
                  >
                    {t("settings.progressionPhaseOption", { phase })}
                  </option>
                ))}
              </select>
            </label>

            {/*
              Job 019: number-format settings (PLAN.md §3: "fraction/
              decimal, digits, rounding"). `updateSettings`'s own doc comment
              requires patching `numberFormats` as a whole object (it's a
              plain JS value, not a nested `Y.Map` — see `mutations.ts`), so
              every control here reads the CURRENT `numberFormats` and writes
              back a full copy with just its own field changed, rather than
              patching a single key.
            */}
            {/* Job 028: reuses `NUMBER_SETTINGS` ("Number Settings") for
                this section heading — the original's own section title for
                exactly this fraction/decimal/digits/rounding control
                cluster (see `NUMBER_SETTINGS_HELP`'s description), just
                slightly different wording than this card's prior "Number
                format" heading. */}
            <p className="mb-1 mt-3 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {tRaw("NUMBER_SETTINGS")}
            </p>
            <label className={rowClass}>
              <span>{tRaw("STYLE")}</span>
              <select
                className={selectClass}
                value={settings.numberFormats.style}
                onChange={(event) =>
                  updateSettings(sfmDoc, {
                    numberFormats: {
                      ...settings.numberFormats,
                      style: event.target.value as NumberFormats["style"],
                    },
                  })
                }
              >
                {NUMBER_FORMAT_STYLES.map((style) => (
                  <option key={style.value} value={style.value}>
                    {t(style.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            {/* Digits/rounding/trim only affect the "decimal" style (`@scm/rational`'s `formatRational` ignores them for "fraction"/"mixed") — disabled rather than hidden, so the setting is still visible and its last value isn't lost when switching styles back and forth. */}
            <label className={rowClass}>
              <span>{tRaw("DIGITS")}</span>
              <input
                type="number"
                min={0}
                max={12}
                disabled={settings.numberFormats.style !== "decimal"}
                value={settings.numberFormats.digits}
                onChange={(event) => {
                  const digits = Number.parseInt(event.target.value, 10);
                  if (Number.isInteger(digits) && digits >= 0) {
                    updateSettings(sfmDoc, {
                      numberFormats: { ...settings.numberFormats, digits },
                    });
                  }
                }}
                className={`nodrag w-14 rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-right text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-40`}
              />
            </label>
            <label className={rowClass}>
              <span>{t("settings.rounding")}</span>
              <select
                className={selectClass}
                disabled={settings.numberFormats.style !== "decimal"}
                value={settings.numberFormats.rounding}
                onChange={(event) =>
                  updateSettings(sfmDoc, {
                    numberFormats: {
                      ...settings.numberFormats,
                      rounding: event.target.value as NumberFormats["rounding"],
                    },
                  })
                }
              >
                {ROUNDING_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.ns ? tRaw(mode.labelKey) : t(mode.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className={rowClass}>
              <span>{t("settings.trimTrailingZeros")}</span>
              <input
                type="checkbox"
                disabled={settings.numberFormats.style !== "decimal"}
                checked={settings.numberFormats.trimTrailingZeros}
                onChange={(event) =>
                  updateSettings(sfmDoc, {
                    numberFormats: {
                      ...settings.numberFormats,
                      trimTrailingZeros: event.target.checked,
                    },
                  })
                }
                className="accent-[var(--accent)] disabled:opacity-40"
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}
