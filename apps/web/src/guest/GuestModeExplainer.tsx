// Guest-mode work: the "what you're choosing" explainer shown (via
// `App.tsx`'s `useConfirmDialog`) before `enterGuestMode()` actually runs,
// and reachable again afterward from the header's Guest Mode badge — see
// `App.tsx`'s own comment on why the same dialog serves both call sites.
// Content matches the product copy supplied for this feature verbatim. The
// per-section color (green check + dots / amber warning + dots / indigo
// shield + dots) takes its cue from Ferrumium's own "Limited Mode" dialog —
// same three-way can-do/miss/privacy split, same at-a-glance color coding —
// reusing this app's existing semantic tokens (`--success`/`--outpost`/
// `--accent`, the same ones already audited in `a11y/contrastAudit.ts`)
// rather than introducing new ones just for this dialog. Bullets are a
// plain colored `<span>` dot, not `list-disc`/`::marker` — a `::marker`
// can't be colored via inline `style` (no element to attach it to), and a
// Tailwind `marker:` utility would need each of the three colors spelled
// out as its own literal class name anyway (Tailwind can't see a value
// built from the `color` prop at build time), so a plain dot is both
// simpler and reuses the same `color` prop the heading icon already takes.
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

interface BulletSectionProps {
  icon: LucideIcon;
  /** A `--*` CSS custom property reference (e.g. `"var(--success)"`), not a raw color — see this file's header comment. Shared by the heading icon and every bullet dot in this section. */
  color: string;
  heading: string;
  items: string[];
}

function BulletSection({ icon: Icon, color, heading, items }: BulletSectionProps) {
  return (
    <div className="mb-3 last:mb-0">
      <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color }} />
        {heading}
      </h4>
      <ul className="space-y-0.5 pl-5 text-sm text-[var(--text-secondary)]">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GuestModeExplainer() {
  const { t } = useTranslation("app");
  return (
    <div className="text-left">
      <BulletSection
        icon={CheckCircle2}
        color="var(--success)"
        heading={t("guestMode.explainer.canDoHeading")}
        items={t("guestMode.explainer.canDoItems", { returnObjects: true }) as string[]}
      />
      <BulletSection
        icon={AlertTriangle}
        color="var(--outpost)"
        heading={t("guestMode.explainer.missHeading")}
        items={t("guestMode.explainer.missItems", { returnObjects: true }) as string[]}
      />
      <BulletSection
        icon={ShieldCheck}
        color="var(--accent)"
        heading={t("guestMode.explainer.privacyHeading")}
        items={t("guestMode.explainer.privacyItems", { returnObjects: true }) as string[]}
      />
    </div>
  );
}
