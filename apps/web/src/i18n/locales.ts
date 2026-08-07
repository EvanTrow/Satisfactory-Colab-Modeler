// Job 028: sources `resources/languages/languages.json` (locale metadata)
// and `resources/languages/translations/*.json` (the actual ~600-key string
// tables, `en-US.json` plus 54 other locales) directly from `resources/` —
// no copy step, same "read directly from resources/, single source of
// truth, no drift risk" pattern Job 003 established for
// `packages/gamedata/src/data.ts`'s `game_data.json` import (see that job's
// Handoff notes for the Vite `server.fs.allow` non-issue Job 010 later
// confirmed against a real dev server).
//
// `en-US.json` is imported eagerly (it's the baseline locale — every app
// boot needs it synchronously, before any user locale choice is known).
// Every other locale is loaded lazily via `import.meta.glob` — with 54 of
// them, eagerly bundling all of them into the main chunk would be pure
// bundle-size waste for the ~99% of a session that only ever uses one
// locale at a time; Vite code-splits each glob entry into its own chunk
// automatically.
import languageNamesJson from "../../../../resources/languages/languages.json";
import enUSTranslationJson from "../../../../resources/languages/translations/en-US.json";

export const DEFAULT_LOCALE = "en-US";

/** Locale code -> native display name (`resources/languages/languages.json`), e.g. `"de"` -> `"Deutsch"`. */
export const LOCALE_DISPLAY_NAMES: Readonly<Record<string, string>> = languageNamesJson;

/** The real ~600-key en-US string table, loaded eagerly (see header comment). */
export const enUSTranslation: Record<string, string> = enUSTranslationJson;

// `en-US.json` is excluded from the glob (it's already eagerly imported
// above) — without this, Vite's build emits an "ineffective dynamic
// import" warning, since the same module would be both statically and
// dynamically imported at once. Purely a build-noise fix; `loadLocaleTranslation`
// below already short-circuits `en-US` before ever consulting this map.
const translationLoaders = import.meta.glob<{ default: Record<string, string> }>([
  "../../../../resources/languages/translations/*.json",
  "!../../../../resources/languages/translations/en-US.json",
]);

function localeCodeFromGlobPath(path: string): string {
  const match = /([^/]+)\.json$/.exec(path);
  if (!match) {
    throw new Error(`locales.ts: could not extract a locale code from glob path "${path}"`);
  }
  return match[1]!;
}

const loadersByLocale = new Map<string, () => Promise<{ default: Record<string, string> }>>(
  Object.entries(translationLoaders).map(([path, loader]) => [localeCodeFromGlobPath(path), loader]),
);

/**
 * Every locale that has both a `languages.json` display-name entry AND a
 * `translations/*.json` file — sorted with `en-US` first (it's the
 * baseline/default choice in any switcher UI), then alphabetically by code.
 * In practice these two sets are identical (55 locales each) but the
 * intersection is computed defensively rather than assumed, so a future
 * mismatch between the two files fails soft (that locale just doesn't show
 * up as selectable) instead of throwing at import time.
 */
export const SUPPORTED_LOCALES: readonly string[] = Object.keys(LOCALE_DISPLAY_NAMES)
  .filter((code) => code === DEFAULT_LOCALE || loadersByLocale.has(code))
  .sort((a, b) => {
    if (a === DEFAULT_LOCALE) return -1;
    if (b === DEFAULT_LOCALE) return 1;
    return a.localeCompare(b);
  });

/** Native display name for a locale code, falling back to the code itself if unknown. */
export function localeDisplayName(locale: string): string {
  return LOCALE_DISPLAY_NAMES[locale] ?? locale;
}

/**
 * Loads one locale's translation table. `en-US` resolves synchronously
 * (already in memory); every other locale triggers its code-split dynamic
 * import on first use, then stays cached by the caller (see `i18n.ts`'s
 * `setLocale`, which only calls this once per locale per session via
 * i18next's own `hasResourceBundle` check).
 */
export async function loadLocaleTranslation(locale: string): Promise<Record<string, string>> {
  if (locale === DEFAULT_LOCALE) return enUSTranslation;
  const loader = loadersByLocale.get(locale);
  if (!loader) {
    throw new Error(`locales.ts: "${locale}" is not a supported locale (no translations/*.json file for it)`);
  }
  const mod = await loader();
  return mod.default;
}
