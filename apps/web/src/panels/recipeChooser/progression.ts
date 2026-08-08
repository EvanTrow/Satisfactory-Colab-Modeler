// Space Elevator ("Project Assembly") delivery-unlock progression — fixed
// game-design data, NOT derivable from `game_data.json` (a recipe's own
// `Tier` field only says what tech is needed to gather that phase's cost,
// not what completing the phase then unlocks). Mirrors the game's real
// "Initial phase requirements" table: each phase's delivery unlocks a
// specific pair of HUB/MAM Tiers (Phase 4 only unlocks one, and Phase 5 —
// "Assembly" — launches Project Assembly rather than unlocking a further
// Tier, so it stays capped at Phase 4's Tier 9).
export const PHASE_MAX_TIER: Readonly<Record<number, number>> = {
  1: 4, // Distribution Platform -> unlocks Tiers 3 and 4
  2: 6, // Construction Dock -> unlocks Tiers 5 and 6
  3: 8, // Main Body -> unlocks Tiers 7 and 8
  4: 9, // Propulsion -> unlocks Tier 9
  5: 9, // Assembly -> Project Assembly launch (no further Tier unlock)
};

/** Every phase number, low to high — the Phase dropdown's option set. */
export const PROGRESSION_PHASES: readonly number[] = Object.keys(PHASE_MAX_TIER)
  .map(Number)
  .sort((a, b) => a - b);

/** The game's highest Tier — also the "no phase filter" cap (an unset phase imposes no ceiling). */
const HIGHEST_TIER = 9;

/** The highest Tier `phase`'s completion unlocks. `null` (no phase filter) imposes no cap. */
export function maxTierForPhase(phase: number | null): number {
  if (phase === null) return HIGHEST_TIER;
  return PHASE_MAX_TIER[phase] ?? HIGHEST_TIER;
}

/**
 * Whether a Tier/Phase project-setting pair could co-exist in a real save —
 * `null` on either side is always valid (an unset axis imposes no
 * constraint of its own). Used both ways: to decide whether a candidate
 * Tier is still pickable once a Phase is set, and vice versa — the
 * underlying rule is the same inequality either direction.
 */
export function isValidProgressionSelection(tier: number | null, phase: number | null): boolean {
  if (tier === null || phase === null) return true;
  return tier <= maxTierForPhase(phase);
}
