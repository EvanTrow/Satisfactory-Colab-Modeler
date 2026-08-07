// Icon manifest / filename resolver, per PLAN.md §1: "Filenames are the
// display name with spaces → underscores (`Iron Ore` → `Iron_Ore.png`), so
// lookup is a pure function with no mapping table needed."
//
// This module deliberately does no filesystem I/O (so it works unmodified
// in a browser bundle) — `verifyIconCoverage` takes the list of available
// filenames as a plain argument instead of reading `resources/images/icons/`
// itself. The package's own test suite (`icons.test.ts`) is what actually
// reads that directory via `node:fs` and calls this function against it.
import type { GameData } from "./types.js";

/**
 * The two icon files documented in PLAN.md §1 that exist for logistics
 * nodes, not any `Part`/`Machine` entry: `"170 parts + 32 machines + 2
 * logistics icons = 204 files"`. `verifyIconCoverage` allows these by
 * default so a correct 204-file `icons/` directory reports zero orphans.
 */
export const KNOWN_NON_ENTITY_ICON_FILES: readonly string[] = [
  "Conveyor_Merger.png",
  "Smart_Splitter.png",
];

/** `"Iron Ore"` → `"Iron_Ore.png"` — the display-name-to-filename rule from PLAN.md §1. */
export function iconFileName(displayName: string): string {
  return `${displayName.replace(/ /g, "_")}.png`;
}

export interface IconCoverageResult {
  /** Part/machine display names with no corresponding file in `availableFiles`. */
  readonly missing: readonly string[];
  /** Files in `availableFiles` that don't correspond to any part/machine and aren't in `knownExtraFiles`. */
  readonly orphans: readonly string[];
  readonly isComplete: boolean;
}

/**
 * Checks every `Part` and `Machine` in `gameData` resolves to a file in
 * `availableFiles`, and that `availableFiles` has no file beyond those plus
 * `knownExtraFiles` (defaults to `KNOWN_NON_ENTITY_ICON_FILES`).
 */
export function verifyIconCoverage(
  gameData: Pick<GameData, "parts" | "machines">,
  availableFiles: readonly string[],
  knownExtraFiles: readonly string[] = KNOWN_NON_ENTITY_ICON_FILES,
): IconCoverageResult {
  const expected = new Set<string>();
  for (const part of gameData.parts) expected.add(iconFileName(part.name));
  for (const machine of gameData.machines) expected.add(iconFileName(machine.name));

  const available = new Set(availableFiles);
  const allowedExtras = new Set(knownExtraFiles);

  const missing = [...expected].filter((file) => !available.has(file)).sort();
  const orphans = [...available]
    .filter((file) => !expected.has(file) && !allowedExtras.has(file))
    .sort();

  return { missing, orphans, isComplete: missing.length === 0 && orphans.length === 0 };
}
