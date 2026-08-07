// Job 028: i18next bootstrap. `react-i18next`'s `useTranslation()` is what
// every component actually calls — this module only owns the singleton
// `i18next` instance's configuration and the locale-switch mechanism.
//
// Two namespaces:
//   - `translation` (i18next's own default namespace name) — the real
//     ~600-key string table from `resources/languages/translations/*.json`,
//     used UNMODIFIED (see `locales.ts`). This is also where every
//     `@scm/gamedata` display name (`"Iron Ore"`, `"Miner Mk.2"`, ...) is
//     looked up as a flat key — the original tool's string table already
//     contains an identity/translated entry for every part, machine, and
//     recipe name (verified: `en-US.json` maps `"Iron Ore"` -> `"Iron Ore"`,
//     `de.json` maps it -> `"Eisenerz"`, etc.) — see `gameTerm.ts`.
//   - `app` — new keys for UI genuinely novel to this reimplementation with
//     no reasonable original-app analogue (presence, connection status,
//     Splurger/priority UI, blueprints, auto-round, the solver-mode/summary
//     specifics...). English only; every other locale relies on
//     `fallbackLng` to reach the en-US bundle for this namespace, since
//     authoring translations is explicitly out of this job's scope.
//
// `keySeparator: false` is required, not cosmetic: 9 real keys in the
// string table contain a literal `.` (`"Miner Mk.1"`, `"Mk.1 Belt"`, ...),
// and i18next's default `keySeparator: "."` would otherwise parse those as
// a nested-object lookup path and never find them.
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import appEnUS from "./app-en-US.json";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, enUSTranslation, loadLocaleTranslation } from "./locales";

export { DEFAULT_LOCALE, SUPPORTED_LOCALES, localeDisplayName } from "./locales";

const STORAGE_KEY = "scm-locale";

function readStoredLocale(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw && SUPPORTED_LOCALES.includes(raw) ? raw : null;
  } catch {
    // Storage can throw in locked-down/private-browsing contexts — see
    // `theme/useTheme.ts`'s identical rationale; fall back rather than crash.
    return null;
  }
}

/** Best-effort match of the browser's own language preference against `SUPPORTED_LOCALES`, exact first then bare-language fallback (e.g. `"de-CH"` -> `"de"`). */
function matchBrowserLocale(): string | null {
  if (typeof navigator === "undefined") return null;
  const candidates = navigator.languages && navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (SUPPORTED_LOCALES.includes(candidate)) return candidate;
    const base = candidate.split("-")[0];
    const match = SUPPORTED_LOCALES.find((locale) => locale === base || locale.split("-")[0] === base);
    if (match) return match;
  }
  return null;
}

export function resolveInitialLocale(): string {
  return readStoredLocale() ?? matchBrowserLocale() ?? DEFAULT_LOCALE;
}

let initPromise: Promise<void> | null = null;

async function doInit(): Promise<void> {
  const initialLocale = resolveInitialLocale();

  await i18next.use(initReactI18next).init({
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    ns: ["translation", "app"],
    defaultNS: "translation",
    keySeparator: false,
    nsSeparator: ":",
    interpolation: { escapeValue: false }, // React already escapes.
    returnEmptyString: false,
    resources: {
      [DEFAULT_LOCALE]: {
        translation: enUSTranslation,
        app: appEnUS,
      },
    },
  });

  if (initialLocale !== DEFAULT_LOCALE) {
    await setLocale(initialLocale);
  }
}

/** Idempotent — safe to call more than once (e.g. React Strict Mode double-invoking effects); only the first call does any work. */
export function initI18n(): Promise<void> {
  initPromise ??= doInit();
  return initPromise;
}

/**
 * Switches the active locale, lazily loading+caching its translation table
 * on first use (see `locales.ts`'s `loadLocaleTranslation`), persists the
 * choice, and resolves once every subscribed component has re-rendered
 * (react-i18next's `useTranslation` re-renders automatically on
 * `languageChanged` — no reload, no prop drilling).
 */
export async function setLocale(locale: string): Promise<void> {
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw new Error(`setLocale: "${locale}" is not a supported locale`);
  }

  if (!i18next.hasResourceBundle(locale, "translation")) {
    const translation = await loadLocaleTranslation(locale);
    i18next.addResourceBundle(locale, "translation", translation, true, true);
  }

  await i18next.changeLanguage(locale);

  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Persistence is a nicety — see `theme/useTheme.ts`'s identical rationale.
  }
}

export default i18next;
