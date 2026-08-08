// Job 024: the pure logic behind the "Splurger" node type — both its
// priority-tier storage convention (used by `canvas/nodes/SplurgerNode.tsx`
// to read/write `NodeRecord.priorityOrder`) and the translation of a
// Splurger's incident edges into direct recipe-to-recipe `SolverEdge`s
// (used by `buildSnapshot.ts`). No `@scm/ydoc`/React import — plain data in,
// plain data out, same discipline `connectedComponents.ts`/`partition.ts`
// already established in this directory, so both the UI and the snapshot
// builder can share one tested implementation instead of two.
//
// ---------------------------------------------------------------------------
// THE DESIGN CALL THIS FILE IMPLEMENTS — read jobs/024-priority-nodes.md's
// Handoff notes for the full writeup; this is the short version.
// ---------------------------------------------------------------------------
//
// Job 023 added `SolverEdge.priorityTier` — a property of an EDGE — but
// `@scm/solver`'s snapshot has no node kind for a pure routing node with no
// recipe/machine (`buildSnapshot.ts`'s header: only `kind: "recipe"` nodes
// can become a `SolverNode` at all). Extending `@scm/solver` itself to
// understand a new node kind is exactly what this job's own scope note
// rules out ("no further solver logic changes").
//
// The approach taken here: a `kind: "splurger"` node IS a real, persisted
// `NodeRecord` and a real, distinct thing on the canvas (Job 024's
// `SplurgerNode.tsx`) that a user can wire real edges through — but it is
// NEVER a `SolverNode`. Instead, `buildSnapshot.ts` treats every Splurger as
// a routing instruction: "erase me, and connect whichever real node feeds my
// one-sided port directly to every real node on my many-sided port,
// carrying my own tier assignment for that connection." This is exact
// (not an approximation) for the two shapes real Satisfactory splitter/
// merger hardware actually has — one input across several outputs
// (splitter), or several inputs into one output (merger) — since those are
// precisely the shapes Job 023's own per-(node,part,direction) sibling-group
// water-filling already solves correctly for a REAL recipe node's own ports.
// A Splurger with multiple inputs AND multiple outputs simultaneously has no
// physical equivalent in the game (no splitter/merger hardware combines
// both) and also has no correct rewrite here: naively connecting every
// input to every output (a "crossbar") would let the solver double-count a
// source's rate across multiple independent per-owner sibling groups, since
// each output's own water-fill group has no idea another output's group is
// drawing from the very same input. Rather than ship that silently-wrong
// behavior, `computeSplurgerPassthroughEdges` excludes that part-group's
// edges from the solver snapshot entirely and reports the node id via
// `unsupportedNodeIds` so `SplurgerNode.tsx` can show a visible warning
// instead of quietly dropping flow with no explanation.
//
// A Splurger chained directly into another Splurger (no real recipe node in
// between) is also not resolved by this module — the rewrite only looks one
// hop away, so a synthetic edge landing on another Splurger's id is later
// dropped by `buildSnapshot.ts`'s existing "both endpoints must be a real
// recipe node" filter, the same way any edge touching an unrepresentable
// node already was. Flagged as a known limitation, not attempted here (see
// Handoff notes) — the common case this job targets is one Splurger between
// two real recipe nodes.

/** The minimal edge shape this module needs — satisfied directly by `@scm/ydoc`'s `EdgeRecord` and by `@scm/solver`'s `SolverEdge`. */
export interface SplurgerEdgeLike {
  readonly id: string;
  readonly part: string;
  readonly fromNode: string;
  readonly fromPort: string;
  readonly toNode: string;
  readonly toPort: string;
}

export type PriorityTier = "top" | "bottom";

// ---------------------------------------------------------------------------
// Priority-tier storage: `NodeRecord.priorityOrder: string[]` (Job 007's
// schema — defined, never used until now), reused rather than adding a new
// `@scm/ydoc` field. Each entry is `"<tier>:<edgeId>"` for one of the
// Splurger's own incident edges; an edge with no entry at all is unassigned
// and defaults to "top" (matching `SolverEdge.priorityTier`'s own
// `undefined`-behaves-as-"top" convention exactly, so an unconfigured
// Splurger's ports all pool together evenly, same as Job 023 established
// for a plain recipe node's own default siblings).
// ---------------------------------------------------------------------------

const TIER_PREFIX = { top: "top:", bottom: "bottom:" } as const;

export interface TierAssignment {
  /** Edge ids assigned to the top tier, in display/tie-break order. */
  readonly top: readonly string[];
  readonly bottom: readonly string[];
}

export const EMPTY_TIER_ASSIGNMENT: TierAssignment = { top: [], bottom: [] };

export function decodePriorityOrder(order: readonly string[]): TierAssignment {
  const top: string[] = [];
  const bottom: string[] = [];
  for (const token of order) {
    if (token.startsWith(TIER_PREFIX.top)) top.push(token.slice(TIER_PREFIX.top.length));
    else if (token.startsWith(TIER_PREFIX.bottom)) bottom.push(token.slice(TIER_PREFIX.bottom.length));
    // Anything else is an unrecognized/foreign token — ignored rather than
    // thrown on, same defensive posture `@scm/ydoc`'s own `nodeToPlain`
    // takes toward malformed doc content elsewhere.
  }
  return { top, bottom };
}

export function encodePriorityOrder(assignment: TierAssignment): string[] {
  return [
    ...assignment.top.map((id) => `${TIER_PREFIX.top}${id}`),
    ...assignment.bottom.map((id) => `${TIER_PREFIX.bottom}${id}`),
  ];
}

export function tierForEdge(assignment: TierAssignment, edgeId: string): PriorityTier | undefined {
  if (assignment.top.includes(edgeId)) return "top";
  if (assignment.bottom.includes(edgeId)) return "bottom";
  return undefined;
}

/** Appends every `connectedEdgeIds` entry not already present in `assignment` onto the END of the top tier, in the given order — materializes the "unassigned defaults to top" convention into a concrete, orderable list. Callers should pass a stable, deterministic order (e.g. edge ids sorted) so re-renders don't reshuffle un-configured ports. */
export function withDefaultedEdges(
  assignment: TierAssignment,
  connectedEdgeIds: readonly string[],
): TierAssignment {
  const known = new Set([...assignment.top, ...assignment.bottom]);
  const missing = connectedEdgeIds.filter((id) => !known.has(id));
  if (missing.length === 0) return assignment;
  return { top: [...assignment.top, ...missing], bottom: assignment.bottom };
}

/** Drops any entry whose edge is no longer connected (deleted, or reconnected elsewhere) so `priorityOrder` doesn't accumulate stale ids forever. */
export function withoutStaleEdges(
  assignment: TierAssignment,
  connectedEdgeIds: readonly string[],
): TierAssignment {
  const known = new Set(connectedEdgeIds);
  return {
    top: assignment.top.filter((id) => known.has(id)),
    bottom: assignment.bottom.filter((id) => known.has(id)),
  };
}

/** Moves `edgeId` to `tier`, appended at the end of its new tier's list. No-op (well, a same-shape copy) if the edge isn't present in `assignment` at all — callers should `withDefaultedEdges` first if they want an unassigned port to be movable. */
export function setTier(assignment: TierAssignment, edgeId: string, tier: PriorityTier): TierAssignment {
  const top = assignment.top.filter((id) => id !== edgeId);
  const bottom = assignment.bottom.filter((id) => id !== edgeId);
  return tier === "top" ? { top: [...top, edgeId], bottom } : { top, bottom: [...bottom, edgeId] };
}

/** Swaps `edgeId` with its immediate neighbor within its OWN tier (never crosses tiers) — the "reorder within a tier" interaction the job file asks for. A no-op at either end of the list, or if `edgeId` isn't assigned to any tier. */
export function moveWithinTier(
  assignment: TierAssignment,
  edgeId: string,
  direction: "up" | "down",
): TierAssignment {
  const tier = tierForEdge(assignment, edgeId);
  if (!tier) return assignment;
  const list = [...assignment[tier]];
  const index = list.indexOf(edgeId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= list.length) return assignment;
  const tmp = list[index]!;
  list[index] = list[swapWith]!;
  list[swapWith] = tmp;
  return tier === "top" ? { ...assignment, top: list } : { ...assignment, bottom: list };
}

// ---------------------------------------------------------------------------
// Shape detection — shared by the UI (a warning banner) and, implicitly, by
// `computeSplurgerPassthroughEdges` below (same classification, per part).
// ---------------------------------------------------------------------------

export type SplurgerShapeKind = "empty" | "passthrough" | "splitter" | "merger" | "unsupported";

export interface SplurgerShape<E extends SplurgerEdgeLike = SplurgerEdgeLike> {
  readonly kind: SplurgerShapeKind;
  readonly inputEdges: readonly E[];
  readonly outputEdges: readonly E[];
  /**
   * Parts present on only ONE side (input-only, or output-only) — since
   * `kind` is computed from TOTAL edge counts across every part at once, a
   * Splurger can read as a perfectly ordinary "passthrough"/"splitter"/
   * "merger" while one or more of its individual parts has nowhere to
   * route: `computeSplurgerPassthroughEdges` groups strictly PER PART and
   * silently produces no synthetic edge at all for a part with nothing on
   * the other side (there's genuinely nowhere to route it) — this is what
   * lets `SplurgerNode.tsx` surface that as a visible warning instead of
   * flow quietly vanishing from the solve with no indication why.
   */
  readonly danglingParts: readonly string[];
  /**
   * Which direction's edges actually own the priority-tier assignment for
   * THIS shape — `"out"` for a splitter (its one input has no tier
   * decision to make), `"in"` for a merger, `null` for every other shape
   * (passthrough/empty/unsupported have no multi-way tiering at all).
   * Mirrors `computeSplurgerPassthroughEdges`'s own "many side owns the
   * tier" rule exactly — `SplurgerNode.tsx` uses this to hide/disable tier
   * controls on rows where toggling them would have no effect on the solve.
   */
  readonly tierOwningDirection: "in" | "out" | null;
}

/**
 * Classifies a Splurger's WHOLE current wiring (every part at once) — what
 * `SplurgerNode.tsx` shows its ports/warning banner from. `computeSplurgerPassthroughEdges`
 * reruns this same input/output split PER PART internally, since two
 * different parts wired through one Splurger are independent routing
 * decisions. Generic over the concrete edge type `E` so a caller passing
 * real `@scm/ydoc` `EdgeRecord[]` (which has more fields than the minimal
 * `SplurgerEdgeLike`) gets `EdgeRecord[]` back out, not a narrowed-down copy.
 */
export function computeSplurgerShape<E extends SplurgerEdgeLike>(
  nodeId: string,
  edges: readonly E[],
): SplurgerShape<E> {
  const inputEdges = edges.filter((e) => e.toNode === nodeId);
  const outputEdges = edges.filter((e) => e.fromNode === nodeId);
  let kind: SplurgerShapeKind;
  if (inputEdges.length === 0 && outputEdges.length === 0) kind = "empty";
  else if (inputEdges.length > 1 && outputEdges.length > 1) kind = "unsupported";
  else if (outputEdges.length > 1) kind = "splitter";
  else if (inputEdges.length > 1) kind = "merger";
  else kind = "passthrough";

  const inputParts = new Set(inputEdges.map((e) => e.part));
  const outputParts = new Set(outputEdges.map((e) => e.part));
  const danglingParts = [...new Set([...inputParts, ...outputParts])].filter(
    (part) => inputParts.has(part) !== outputParts.has(part),
  );

  const tierOwningDirection = kind === "splitter" ? "out" : kind === "merger" ? "in" : null;

  return { kind, inputEdges, outputEdges, danglingParts, tierOwningDirection };
}

/**
 * Whether each side of a `kind: "splurger"` node shows TWO priority-tier
 * groups ("Top — priority"/"Bottom — overflow") or just a single flat list
 * — a STATIC property of the node's own `splurgerVariant` (`@scm/ydoc`'s
 * `splurgerPortCaps`), not of current wiring the way `computeSplurgerShape`'s
 * `tierOwningDirection` is. Takes a plain `{ in; out }` shape rather than
 * importing `@scm/ydoc`'s `SplurgerPortCaps` type directly — this module
 * stays dependency-free by design (see this file's header) — but is meant
 * to be called with exactly that object from `SplurgerNode.tsx`.
 */
export function tierGroupsForCaps(caps: { readonly in: number; readonly out: number }): {
  readonly in: boolean;
  readonly out: boolean;
} {
  return { in: caps.in > 1, out: caps.out > 1 };
}

// ---------------------------------------------------------------------------
// The solver-facing rewrite.
// ---------------------------------------------------------------------------

export interface PassthroughSolverEdge {
  readonly id: string;
  readonly part: string;
  readonly fromNode: string;
  readonly fromPort: string;
  readonly toNode: string;
  readonly toPort: string;
  readonly priorityTier?: PriorityTier;
}

export interface SplurgerNodeLike {
  readonly id: string;
  readonly priorityOrder: readonly string[];
}

export interface SplurgerPassthroughResult {
  readonly edges: readonly PassthroughSolverEdge[];
  /**
   * Splurger node ids with at least one part-group wired as multiple-in AND
   * multiple-out simultaneously — see this file's header for why that shape
   * has no correct rewrite and is deliberately excluded rather than
   * approximated. `buildSnapshot.ts` doesn't need this (it just wants the
   * edges), but `SplurgerNode.tsx` uses it to warn the user their wiring
   * isn't being routed by the solver rather than leaving them to notice a
   * silent flow discrepancy on their own.
   */
  readonly unsupportedNodeIds: ReadonlySet<string>;
}

/**
 * Reads a tier directly off one of THIS Splurger's own port strings — see
 * `edges/connectionLogic.ts`'s `WILDCARD_PART_TOP`/`WILDCARD_PART_BOTTOM`
 * (`"*top"`/`"*bottom"`, duplicated here as literals rather than imported —
 * this module stays dependency-free by design, see its header). New
 * connections made through a tiered side's two real handles carry their
 * tier this way, for free, with no `priorityOrder` bookkeeping needed at
 * all. `undefined` for an edge whose port is still the plain `"*"` wildcard
 * — a 1-cap side's only handle (no tier concept), or a LEGACY edge made
 * before this port-per-tier scheme existed — callers fall back to the
 * `priorityOrder`-based `tierForEdge` for those, so an old document's
 * existing tier assignments keep working unchanged.
 */
function tierFromPort(port: string): PriorityTier | undefined {
  if (port.endsWith("*top")) return "top";
  if (port.endsWith("*bottom")) return "bottom";
  return undefined;
}

/**
 * Rewrites every `splurgers` node's incident edges into direct
 * recipe-to-recipe `PassthroughSolverEdge`s, grouped by `part` (a Splurger
 * carrying two different parts across different port pairs is treated as
 * two entirely independent routing decisions). For a part-group with
 * exactly one edge on one side and one-or-more on the other, every
 * many-side edge becomes one synthetic edge sourced/targeted at the
 * one-side edge's OWN real endpoint, carrying the many-side edge's own
 * tier assignment (`tierForEdge`) — this is what lets Job 023's existing
 * per-owner-node sibling-group water-filling apply unchanged, with the
 * Splurger itself never appearing as a `SolverNode` at all. A part-group
 * with nothing on one side (dangling) produces no synthetic edge for that
 * part (there's genuinely nowhere to route it — not a dropped connection,
 * a disconnected one). A part-group with more than one edge on BOTH sides
 * is excluded and its owning node id recorded in `unsupportedNodeIds`
 * instead of guessing at a crossbar.
 */
export function computeSplurgerPassthroughEdges(
  splurgers: readonly SplurgerNodeLike[],
  edges: readonly SplurgerEdgeLike[],
): SplurgerPassthroughResult {
  const result: PassthroughSolverEdge[] = [];
  const unsupportedNodeIds = new Set<string>();

  for (const splurger of splurgers) {
    const incident = edges.filter((e) => e.fromNode === splurger.id || e.toNode === splurger.id);
    if (incident.length === 0) continue;

    const assignment = decodePriorityOrder(splurger.priorityOrder);
    const byPart = new Map<string, { inputs: SplurgerEdgeLike[]; outputs: SplurgerEdgeLike[] }>();
    for (const edge of incident) {
      const group = byPart.get(edge.part) ?? { inputs: [], outputs: [] };
      if (edge.toNode === splurger.id) group.inputs.push(edge);
      if (edge.fromNode === splurger.id) group.outputs.push(edge);
      byPart.set(edge.part, group);
    }

    for (const [part, group] of byPart) {
      const { inputs, outputs } = group;
      if (inputs.length === 0 || outputs.length === 0) continue;
      if (inputs.length > 1 && outputs.length > 1) {
        unsupportedNodeIds.add(splurger.id);
        continue;
      }
      if (inputs.length === 1) {
        const input = inputs[0]!;
        for (const output of outputs) {
          result.push({
            id: `sp:${input.id}>${output.id}`,
            part,
            fromNode: input.fromNode,
            fromPort: input.fromPort,
            toNode: output.toNode,
            toPort: output.toPort,
            priorityTier: tierFromPort(output.fromPort) ?? tierForEdge(assignment, output.id),
          });
        }
      } else {
        const output = outputs[0]!;
        for (const input of inputs) {
          result.push({
            id: `sp:${input.id}>${output.id}`,
            part,
            fromNode: input.fromNode,
            fromPort: input.fromPort,
            toNode: output.toNode,
            toPort: output.toPort,
            priorityTier: tierFromPort(input.toPort) ?? tierForEdge(assignment, input.id),
          });
        }
      }
    }
  }

  return { edges: result, unsupportedNodeIds };
}
