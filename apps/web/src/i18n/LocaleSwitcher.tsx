// Job 028: the locale switcher — a plain native `<select>` (55 options,
// nothing fancy needed) matching `theme/ThemeToggle.tsx`'s "small piece of
// permanent chrome" sizing convention so it drops into the same header rows
// (`App.tsx`'s login chrome, `CanvasView.tsx`'s toolbar) without changing
// their layout rhythm.
import { useTranslation } from "react-i18next";

import { useLocale } from "./useLocale";

export interface LocaleSwitcherProps {
  className?: string;
}

const baseClass =
  "nodrag h-7 shrink-0 rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]";

export function LocaleSwitcher({ className }: LocaleSwitcherProps) {
  const { t } = useTranslation("app");
  const { locale, setLocale, supportedLocales, localeDisplayName } = useLocale();

  return (
    <select
      value={locale}
      onChange={(event) => setLocale(event.target.value)}
      title={t("locale.switcherTitle")}
      aria-label={t("locale.switcherTitle")}
      className={className ?? baseClass}
    >
      {supportedLocales.map((code) => (
        <option key={code} value={code}>
          {localeDisplayName(code)}
        </option>
      ))}
    </select>
  );
}
