// Guest-mode work: replaces `App.tsx`'s old plain-text "Log in with Discord
// to see your projects" prompt for a logged-out visitor. Ferrumium-inspired
// per PLAN.md's own visual-language mandate (see that file's intro) — a
// bold two-line headline, a live (real, not mocked — `SampleFactoryPreview`)
// factory diagram, and a feature grid below, rather than a bare login
// button. `App.tsx`'s existing compact header (title, theme toggle,
// settings) is kept as-is above this; this component owns everything below
// it.
import { useTranslation } from "react-i18next";

import { SampleFactoryPreview } from "./SampleFactoryPreview";

interface LandingPageProps {
  onContinueAsGuest: () => void;
}

interface LandingFeature {
  title: string;
  body: string;
}

export function LandingPage({ onContinueAsGuest }: LandingPageProps) {
  const { t } = useTranslation("app");
  const features = t("landing.features", { returnObjects: true }) as LandingFeature[];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 xl:max-w-7xl 2xl:max-w-[1440px]">
      <section className="grid gap-10 py-16 md:grid-cols-2 md:items-center md:py-24">
        <div>
          <p className="mb-3 text-sm font-medium uppercase tracking-wide text-[var(--accent)]">
            {t("landing.eyebrow")}
          </p>
          <h1 className="text-4xl font-bold tracking-tight text-[var(--text-primary)] md:text-5xl">
            {t("landing.headline1")}
            <br />
            {t("landing.headline2")}
          </h1>
          <p className="mt-4 max-w-md text-base text-[var(--text-secondary)]">{t("landing.subhead")}</p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a
              href="/auth/discord/login"
              className="rounded-md bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
            >
              {t("landing.logInWithDiscord")}
            </a>
            <button
              type="button"
              onClick={onContinueAsGuest}
              className="rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-5 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
            >
              {t("landing.continueAsGuest")}
            </button>
          </div>
          <p className="mt-2 text-xs text-[var(--text-muted)]">{t("landing.continueAsGuestSubtext")}</p>
        </div>

        <div className="relative">
          <div className="absolute -right-3 -top-3 z-10 rounded-md border border-[var(--border-default)] bg-[var(--surface-overlay)] px-2 py-1 text-xs font-medium text-[var(--text-secondary)] shadow-[var(--shadow-modal)]">
            {t("landing.sampleBadge")}
          </div>
          <div className="h-[320px] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-panel)] shadow-[var(--shadow-modal)] md:h-[420px] lg:h-[480px] xl:h-[560px]">
            <SampleFactoryPreview />
          </div>
          <p className="mt-3 text-center text-xs text-[var(--text-muted)] md:text-left">
            {t("landing.sampleSubtext")}
          </p>
        </div>
      </section>

      <section className="border-t border-[var(--border-subtle)] py-16">
        <h2 className="mb-10 text-center text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
          {t("landing.featuresHeading")}
        </h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-card)] p-5"
            >
              <h3 className="mb-1.5 text-sm font-semibold text-[var(--text-primary)]">{feature.title}</h3>
              <p className="text-sm text-[var(--text-secondary)]">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
