// A byproduct — a secondary (non-primary) positive-amount output — that's
// being produced but has zero outgoing edges is easy to miss on a busy
// canvas: unlike an unconnected PRIMARY output (normal mid-build, not yet
// wired to its next step), a byproduct with nothing consuming it has
// nowhere to go and will back the whole machine up. This module answers
// that narrow question directly, mirroring `computeInputShortage.ts`'s own
// "pure, React/Yjs-free, unit-testable with plain fixture objects"
// discipline — `RecipeNode.tsx` is the thin JSX layer that reads its output.
import type { Recipe } from "@scm/gamedata";
import { isPositive } from "@scm/rational";

import { partHandleId, primaryPart } from "./recipeNodeMath";

/**
 * Every output part in `recipe.parts` that ISN'T the recipe's own primary
 * output (`primaryPart`) and has no entry in `connectedPorts` for its own
 * output handle id (`partHandleId`) — i.e. a byproduct with literally
 * nothing consuming it. Empty when every byproduct already has at least one
 * outgoing edge, or the recipe produces no byproducts at all.
 */
export function computeUnhandledByproducts(
  recipe: Pick<Recipe, "parts">,
  connectedPorts: ReadonlySet<string>,
): readonly string[] {
  const primary = primaryPart(recipe);
  return recipe.parts
    .filter((p) => isPositive(p.amount) && p.part !== primary?.part)
    .filter((p) => !connectedPorts.has(partHandleId(p)))
    .map((p) => p.part);
}
