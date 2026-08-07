// Job 021: the soft field-level "someone else is editing this" indicator —
// PLAN.md §5's explicit "colored ring + avatar on the field, never a hard
// lock" and §3's "soft field-level indicators when someone else is typing in
// a field". Used by `RecipeNode.tsx` on the limit/clock/shards fields.
// Deliberately renders nothing that could ever disable/block the local
// user's own input — this component only ever adds a purely visual overlay
// on top of a field the caller's own markup keeps fully interactive.
import type { RemotePresence } from "./useRemotePresence";

export interface FieldPresenceRingProps {
  /** Every remote peer currently reporting `editingField` on this exact `{nodeId, field}` pair — see `RecipeNode.tsx`'s `remoteEditorsFor`. Empty means "render nothing." */
  editors: RemotePresence[];
}

export function FieldPresenceRing({ editors }: FieldPresenceRingProps) {
  if (editors.length === 0) return null;
  const primary = editors[0]!.state;
  const title =
    editors.length === 1
      ? `${primary.displayName} is editing this field`
      : `${editors.map((e) => e.state.displayName).join(", ")} are editing this field`;

  return (
    <>
      {/* The ring itself — a box-shadow (not `border`/`ring-*` utility) so it never fights the field's own border/focus-ring for layout space or specificity, matching `RecipeNode.tsx`'s own `highlightRingClass` precedent for dynamic, non-token colors. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-0.5 rounded"
        style={{ boxShadow: `0 0 0 2px ${primary.color}` }}
      />
      <span
        title={title}
        className="pointer-events-none absolute -right-2 -top-2 h-4 w-4 overflow-hidden rounded-full border-2 bg-[var(--surface-sunken)] shadow"
        style={{ borderColor: primary.color }}
      >
        <img src={primary.avatarUrl} alt="" className="h-full w-full object-cover" />
      </span>
    </>
  );
}
