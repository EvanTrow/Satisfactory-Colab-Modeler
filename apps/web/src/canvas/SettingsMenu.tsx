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
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { updateSettings, type NumberFormats, type Settings, type SolverMode } from "@scm/ydoc";

import type { SfmDocument } from "@scm/ydoc";

import { useFocusTrap } from "../a11y";
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
 * Job 028: the original tool's own `*_SOLVER`/`*_SOLVER_HELP` keys
 * (`en-US.json`) are just the bare mode name ("Basic") plus a paragraph
 * help text — neither matches this dropdown's own longer inline
 * descriptions ("Basic (entered values are limits)"), so these labels are
 * new `app` namespace keys rather than a forced reuse of `BASIC_SOLVER`
 * etc. (see jobs/028-i18n.md Handoff notes).
 */
const SOLVER_MODES: readonly { value: SolverMode; labelKey: string }[] = [
  { value: "none", labelKey: "settings.solverMode.none" },
  { value: "manual", labelKey: "settings.solverMode.manual" },
  { value: "basic", labelKey: "settings.solverMode.basic" },
  { value: "full", labelKey: "settings.solverMode.full" },
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
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
          <path
            fillRule="evenodd"
            d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 00-.986.57c-.166.115-.334.126-.45.083l-1.204-.444a1.875 1.875 0 00-2.279.83l-.222.383a1.875 1.875 0 00.42 2.404l.984.821c.093.078.16.213.147.409a7.55 7.55 0 000 1.139c.013.196-.054.331-.147.409l-.984.821a1.875 1.875 0 00-.42 2.404l.222.383c.454.782 1.42 1.113 2.279.83l1.204-.444c.116-.043.284-.032.45.083.312.216.642.406.985.57.183.088.278.228.298.348l.178 1.072c.151.904.933 1.567 1.85 1.567h.844c.917 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.348.343-.164.673-.354.985-.57.166-.115.334-.126.45-.083l1.204.444a1.875 1.875 0 002.28-.83l.222-.383a1.875 1.875 0 00-.421-2.404l-.984-.821c-.093-.078-.16-.213-.146-.409a7.53 7.53 0 000-1.139c-.014-.196.053-.331.146-.409l.984-.821a1.875 1.875 0 00.421-2.404l-.222-.383a1.875 1.875 0 00-2.28-.83l-1.204.444c-.116.043-.284.032-.45-.083a7.49 7.49 0 00-.985-.57c-.183-.088-.277-.228-.297-.348L12.772 3.817a1.875 1.875 0 00-1.85-1.567h-.844zM10 13.125a3.125 3.125 0 100-6.25 3.125 3.125 0 000 6.25z"
            clipRule="evenodd"
          />
        </svg>
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
                onChange={(event) =>
                  updateSettings(sfmDoc, { solverMode: event.target.value as SolverMode })
                }
              >
                {SOLVER_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {t(mode.labelKey)}
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
