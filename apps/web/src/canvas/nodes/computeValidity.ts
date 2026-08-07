// Job 019: maps `@scm/solver`'s `NodeSolveResult`/`EdgeSolveResult` validity
// onto `RecipeNodeValidityState` (`./validityState.ts`) — the red/orange
// split PLAN.md §3 asks for ("red highlighting for invalid values and
// orange for non-matching"). Deliberately pure and React/Yjs-free (same
// discipline `recipeNodeMath.ts` established for Job 010's own math), so
// this is unit-testable with plain fixture objects — no `SfmDocument`, no
// `@scm/gamedata`, no rendering.
//
// ---------------------------------------------------------------------------
// THE RED-VS-ORANGE MAPPING, PRECISELY (read this before changing anything)
// ---------------------------------------------------------------------------
//
// "invalid" (red) = a value that's individually wrong on its OWN terms,
// independent of anything it's connected to:
//   - `NodeSolveResult.valid === false` — the node's own recipe/machine
//     couldn't be resolved, its shard count was out of range, or (Manual/
//     Basic mode's `pinnedMachineCount`) its entered `limit` was malformed
//     or couldn't be turned into a machine count at all
//     (`nodeProfile.ts`'s `pinnedMachineCount`/`buildNodeProfile` issue
//     strings — see `classifyNodeIssue` below for how the exact wording is
//     mapped to `fields.limit`/`fields.shards`).
//   - An edge whose `EdgeSolveResult.valid === false` for a reason OTHER
//     than a rate mismatch (i.e. `validateEdge`'s "source/target node could
//     not be resolved" or "recipe has no part" issues) — these are
//     downstream consequences of an already-broken node, so they get the
//     same "individually wrong" (red) treatment on the port, not "doesn't
//     reconcile" orange.
//
// "mismatched" (orange) = a value that's individually FINE — both
// endpoints resolved, both sides computed a real rate — but the two sides
// don't agree: `validateEdge`'s "rate mismatch on part ..." issue
// specifically (the ONLY thing that produces this state). This is exactly
// PLAN.md's "orange for non-matching" — e.g. a Basic-mode graph where an
// unresolved node between two independently-pinned neighbors ends up with
// an outgoing share that doesn't equal what a sibling edge on the other
// side implies.
//
// A node/port with both kinds of contributor is "invalid" — invalid always
// wins (see `escalate` below), since an individually-broken value is a more
// severe problem than a mere disagreement between two otherwise-valid
// values.
//
// One deliberate NON-highlight, worth being explicit about: Basic mode's
// "no limit and no resolvable neighbor — defaulted to 1 machine" case
// (`basic.ts`) sets `NodeSolveResult.resolved: false` but leaves `.valid:
// true` (it's not `forceInvalid` — see that module's own comment). This
// function does NOT highlight that case at all (neither red nor orange):
// it isn't "wrong" (nothing contradicts it) and it isn't "mismatched"
// (there's no neighbor's value to disagree with — there IS no neighbor).
// It's a third, genuinely different situation ("undetermined, arbitrarily
// defaulted") that PLAN.md's two-color scheme has no color for. Flagged in
// this job's Handoff notes as a gap a later job could fill with a third,
// distinct visual treatment (e.g. a dashed border) if it turns out to
// matter in practice.
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import type { RecipeNodeValidity, RecipeNodeValidityState } from "./validityState";

/** An edge incident to the node being evaluated — just enough to look up its `EdgeSolveResult` and know which part-row/port it affects. */
export interface IncidentEdgeRef {
  readonly edgeId: string;
  readonly part: string;
}

const LIMIT_ISSUE_PATTERN = /limit/i;
const SHARD_ISSUE_PATTERN = /shard/i;
const RATE_MISMATCH_PATTERN = /rate mismatch/i;

/**
 * Maps one of `NodeSolveResult.issues`' known message shapes (see
 * `nodeProfile.ts`'s `pinnedMachineCount`/`somersloopBoost`) to the
 * `RecipeNodeValidityState.fields` key it should highlight. Every
 * limit-related issue string this package's solver actually produces
 * contains the word "limit" (`invalid limit "..."`, `limitMode "ppm" but
 * the recipe has no part to anchor it to`, `could not derive a machine
 * count from the "ppm" limit on part "..."`); every shard-related one
 * contains "shard" (`somersloopBoost`'s own error text). Anything else
 * (`unknown recipe "..."`, `could not resolve machine variant "..."`) isn't
 * attributable to one specific field, so it only highlights the whole card
 * (`overall`), not a field.
 */
function classifyNodeIssue(issue: string): "limit" | "shards" | undefined {
  if (LIMIT_ISSUE_PATTERN.test(issue)) return "limit";
  if (SHARD_ISSUE_PATTERN.test(issue)) return "shards";
  return undefined;
}

/** "invalid" beats "mismatched" beats "valid" — see the module header's "invalid always wins" note. */
function escalate(current: RecipeNodeValidity, next: RecipeNodeValidity): RecipeNodeValidity {
  if (current === "invalid" || next === "invalid") return "invalid";
  if (current === "mismatched" || next === "mismatched") return "mismatched";
  return "valid";
}

/**
 * Computes one node's `RecipeNodeValidityState` from its own solver result
 * plus every edge incident to it. `null` when `nodeResult` is `undefined` —
 * i.e. there is no solver result for this node at all yet (None mode,
 * mode "none"'s `solveNone()` never populates `nodes`, or a pre-first-solve
 * render before `useSolver`'s scheduler has produced anything) — nothing to
 * highlight either way, which is the correct behavior: PLAN.md §2's None
 * mode computes nothing, so it should show no red/orange either.
 */
export function computeNodeValidityState(
  nodeResult: NodeSolveResult | undefined,
  incidentEdges: readonly IncidentEdgeRef[],
  edgeResultById: ReadonlyMap<string, EdgeSolveResult>,
): RecipeNodeValidityState | null {
  if (!nodeResult) return null;

  let overall: RecipeNodeValidity = "valid";
  const fields: Partial<Record<"limit" | "clock" | "shards", RecipeNodeValidity>> = {};

  if (!nodeResult.valid) {
    overall = "invalid";
    for (const issue of nodeResult.issues) {
      const field = classifyNodeIssue(issue);
      if (field) fields[field] = "invalid";
    }
  }

  const ports: Record<string, RecipeNodeValidity> = {};
  for (const incident of incidentEdges) {
    const edgeResult = edgeResultById.get(incident.edgeId);
    if (!edgeResult || edgeResult.valid) continue;

    const isRateMismatch = edgeResult.issues.some((issue) => RATE_MISMATCH_PATTERN.test(issue));
    const severity: RecipeNodeValidity = isRateMismatch ? "mismatched" : "invalid";
    overall = escalate(overall, severity);
    ports[incident.part] = escalate(ports[incident.part] ?? "valid", severity);
  }

  return {
    overall,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(Object.keys(ports).length > 0 ? { ports } : {}),
  };
}
