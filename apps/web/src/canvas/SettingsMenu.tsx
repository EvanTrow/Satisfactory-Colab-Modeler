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
import { useState } from "react";

import { updateSettings, type Settings } from "@scm/ydoc";

import type { SfmDocument } from "@scm/ydoc";

export interface SettingsMenuProps {
  sfmDoc: SfmDocument;
  settings: Settings;
}

const rowClass = "flex items-center justify-between gap-3 px-1 py-1 text-sm text-[var(--text-secondary)]";

export function SettingsMenu({ sfmDoc, settings }: SettingsMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Snap-to-grid settings"
        aria-label="Snap-to-grid settings"
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
            className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-2 shadow-[var(--shadow-modal)]"
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
            <p className="mb-1 px-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">Snap to grid</p>
            <label className={rowClass}>
              <span>
                Machines
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
                Waypoints
                <span className="ml-1 text-[var(--text-muted)]">
                  ({settings.gridWaypoint.x}×{settings.gridWaypoint.y}px)
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.snapWaypoints}
                onChange={(event) => updateSettings(sfmDoc, { snapWaypoints: event.target.checked })}
                className="accent-[var(--accent)]"
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}
