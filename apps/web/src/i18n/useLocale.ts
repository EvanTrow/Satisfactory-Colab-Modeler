// Job 028: thin wrapper around `react-i18next`'s `useTranslation()` that
// exposes the currently-active locale plus the switcher mechanism
// (`setLocale`), matching `theme/useTheme.ts`'s shape/naming convention
// (`{ value, setValue }`-ish) for consistency with the one other
// localStorage-backed preference this app already has.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { SUPPORTED_LOCALES, localeDisplayName, setLocale as setLocaleImpl } from "./i18n";

export interface UseLocaleResult {
  locale: string;
  /** Fire-and-forget — the switch itself is async (lazy-loads the target locale's translation table on first use), but callers don't need to await it: every subscribed component re-renders on its own once `i18next`'s `languageChanged` event fires. */
  setLocale: (locale: string) => void;
  supportedLocales: readonly string[];
  localeDisplayName: (locale: string) => string;
}

export function useLocale(): UseLocaleResult {
  const { i18n } = useTranslation();

  const setLocale = useCallback((locale: string) => {
    void setLocaleImpl(locale);
  }, []);

  return {
    locale: i18n.language,
    setLocale,
    supportedLocales: SUPPORTED_LOCALES,
    localeDisplayName,
  };
}
