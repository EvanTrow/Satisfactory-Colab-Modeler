import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { LocaleSwitcher } from "../i18n";

interface UserSettingsPageProps {
  /** Returns to the project list — Settings is only reachable from there (see `App.tsx`'s `View` comment), so this always goes back to the same place. */
  onBack: () => void;
}

const sectionClass = "rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-4";

/**
 * Account-level settings — distinct from the per-project settings
 * `canvas/SettingsMenu.tsx` owns (snap-to-grid, connection style, solver
 * mode, ...), which stay CRDT `Settings` fields scoped to one document.
 * Everything on this page is a plain browser/UI-level preference
 * (localStorage-backed, like `theme/useTheme.ts`), not project data.
 *
 * Currently holds only the language/locale picker (previously duplicated
 * across the top header, the canvas header, and the per-project settings
 * popover — now lives in exactly one place), but built as a real
 * page-with-sections shape so future account-level preferences (e.g. theme,
 * once it moves here too) have an obvious place to land without a redesign
 * — just add another `<section className={sectionClass}>` block below.
 */
export function UserSettingsPage({ onBack }: UserSettingsPageProps) {
  const { t } = useTranslation("app");

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
        >
          <ArrowLeft className="inline h-3 w-3" aria-hidden /> {t("settingsPage.back")}
        </button>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{t("settingsPage.heading")}</h2>
      </div>

      <div className="flex flex-col gap-4">
        <section className={sectionClass}>
          <h3 className="mb-1 text-sm font-semibold text-[var(--text-primary)]">
            {t("settingsPage.language")}
          </h3>
          <p className="mb-3 text-xs text-[var(--text-muted)]">{t("settingsPage.languageDescription")}</p>
          <LocaleSwitcher className="h-8 w-full max-w-xs rounded-md border border-[var(--border-default)] bg-[var(--surface-sunken)] px-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none" />
        </section>
      </div>
    </div>
  );
}
