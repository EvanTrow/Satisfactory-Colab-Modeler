// Shared visual tokens for recipe-node field controls — split out of
// `RecipeNode.tsx` so `RecipeNodeQuickSettings.tsx` (the right-click quick
// settings menu) can reuse the exact same styling for the fields it now
// owns (clock/auto-round/somersloops/name), instead of drifting from the
// card's own remaining fields (limit).
export const stepperButtonClass =
  "nodrag flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] text-[var(--text-secondary)] hover:enabled:border-[var(--border-strong)] hover:enabled:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40";

export const fieldInputClass =
  "nodrag w-16 rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-right text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none";

/**
 * Job 027: "Signalled by black field backgrounds" (PLAN.md §2's Auto-round
 * row, verbatim) — deliberately a LITERAL black, not a themed
 * `--surface-*` token, matching `index.css`'s `--node-header` treatment.
 * Applied to the limit field (still on the card) and the clock field (now
 * in the quick settings menu) — both read as "under auto-round's control."
 */
export const autoRoundFieldClass = "!bg-black !text-white placeholder:!text-white/60";
