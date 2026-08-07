// Job 021: Yjs **Awareness** — the presence wire shape PLAN.md §5 specifies
// exactly, plus the pure, unit-testable logic around it (color derivation,
// container-scoped cursor visibility, and runtime validation of a remote
// peer's raw awareness state). Deliberately has no React/DOM imports —
// matches this repo's established "extract pure logic into its own tested
// module" convention (every canvas job since 009: `snapToGrid.ts`,
// `recipeNodeMath.ts`, `portMapping.ts`, `summaryMath.ts`, ...).
//
// PLAN.md §5, quoted verbatim:
//   { userId, displayName, avatarUrl, color,        // color derived from userId hash
//     cursor: { x, y, containerId } | null,          // containerId scopes cursors to an outpost
//     selection: string[],                           // node ids, drawn as a colored halo
//     editingField: { nodeId, field } | null }       // soft indicator, not a lock
//
// Genuinely ephemeral, per PLAN.md's own framing ("Yjs Awareness — ephemeral,
// never persisted, never touches Postgres"): this state only ever lives
// inside the live `Awareness` instance a `HocuspocusProvider` owns
// (`y-protocols/awareness`, held in memory per WebSocket connection,
// gossiped peer-to-peer over it), never inside `sfmDoc`/`Y.Doc`, and nothing
// in this job's code ever routes it through `@scm/doc-storage`/Postgres.
import type { HocuspocusProvider } from "@hocuspocus/provider";

/**
 * The live `Awareness` instance a `HocuspocusProvider` owns
 * (`provider.awareness`). Named via `NonNullable<...>` on the provider's own
 * typed getter rather than `import type { Awareness } from
 * "y-protocols/awareness"` directly: `y-protocols` is only a *peer*
 * dependency of `@hocuspocus/provider` (see `apps/web/package.json` — it's
 * not declared there directly, only transitively required to satisfy
 * `@hocuspocus/provider`'s peer dependency, same as `apps/realtime`'s own
 * `package.json` only lists it as a devDependency for its provider-side
 * tests). TypeScript can still fully resolve the referenced type
 * transitively through `@hocuspocus/provider`'s own `.d.ts` this way, with
 * no separate runtime import needed anywhere in `apps/web` — every actual
 * `Awareness` *instance* this app ever touches always originates from a real
 * `HocuspocusProvider` (`useProjectDocument.ts`), never constructed
 * standalone here.
 */
export type AwarenessHandle = NonNullable<HocuspocusProvider["awareness"]>;

export interface AwarenessCursor {
  x: number;
  y: number;
  /** Job 013's "container currently being viewed" id — the whole reason this field exists on the wire shape at all: see `isCursorVisibleInContainer` below. */
  containerId: string;
}

export interface AwarenessEditingField {
  nodeId: string;
  /** `"limit" | "clock" | "shards"` in practice (the three fields `RecipeNode.tsx` wires up) — kept as a plain `string`, not a union, so this module doesn't need to know about `RecipeNode`'s specific field set. */
  field: string;
}

/** PLAN.md §5's exact Awareness state shape. */
export interface AwarenessState {
  userId: string;
  displayName: string;
  avatarUrl: string;
  color: string;
  cursor: AwarenessCursor | null;
  selection: string[];
  editingField: AwarenessEditingField | null;
}

/** The subset of a logged-in user's own identity needed to publish this client's local Awareness state — `App.tsx` derives this from `GET /auth/me`'s response (see that file's header comment) and threads it down to `CanvasView`. */
export interface LocalUserIdentity {
  id: string;
  displayName: string;
  avatarUrl: string;
}

/**
 * Deterministic per-user color, derived from `userId` alone — PLAN.md §5's
 * "color derived from userId hash" — so the same user always gets the same
 * color across reconnects, page reloads, and separate sessions (there is no
 * server-side "assign a color" step to be consistent with; every client
 * computes the identical answer independently from the same `userId`
 * string). A simple 32-bit rolling hash (not cryptographic — doesn't need to
 * be, this only needs to be stable and roughly well-distributed across hues)
 * mapped into a fixed-saturation/lightness HSL hue, so every generated color
 * reads clearly against both this app's light and dark surface tokens
 * without needing per-color contrast tuning (unlike, say, picking from a
 * small fixed palette by `userId.length % paletteSize`, which collides far
 * more often for short id sets).
 */
export function colorFromUserId(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    // `| 0` keeps this a 32-bit signed int on every iteration (matches
    // JavaScript's own bitwise-op semantics) so the result is fully
    // deterministic across engines/runs, not dependent on floating-point
    // accumulation.
    hash = (Math.imul(hash, 31) + userId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

/** Builds this client's own initial local Awareness state — `useLocalPresence.ts` publishes this once (via `awareness.setLocalState`) as soon as an `Awareness` handle exists. */
export function createLocalAwarenessState(user: LocalUserIdentity): AwarenessState {
  return {
    userId: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    color: colorFromUserId(user.id),
    cursor: null,
    selection: [],
    editingField: null,
  };
}

function parseCursor(raw: unknown): AwarenessCursor | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.x !== "number" || typeof value.y !== "number" || typeof value.containerId !== "string") {
    return null;
  }
  return { x: value.x, y: value.y, containerId: value.containerId };
}

function parseEditingField(raw: unknown): AwarenessEditingField | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.nodeId !== "string" || typeof value.field !== "string") return null;
  return { nodeId: value.nodeId, field: value.field };
}

/**
 * Runtime validator for a peer's raw Awareness state, as read straight off
 * `Awareness.getStates()` (typed `any` by `y-protocols` itself — a remote
 * peer's browser is not something this client controls the shape of, and a
 * mid-connect peer can briefly have an empty/partial state before its own
 * `setLocalState` call lands). Returns `null` for anything that doesn't
 * fully match PLAN.md §5's shape rather than throwing or rendering a
 * half-formed presence entry — every consumer (`useRemotePresence.ts` and
 * everything built on it) treats `null` as "not a real, ready peer yet,"
 * simply omitting that entry rather than crashing the canvas.
 */
export function parseAwarenessState(raw: unknown): AwarenessState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  if (typeof value.userId !== "string" || value.userId.length === 0) return null;
  if (typeof value.displayName !== "string") return null;
  if (typeof value.avatarUrl !== "string") return null;
  if (typeof value.color !== "string") return null;
  if (!Array.isArray(value.selection) || !value.selection.every((entry) => typeof entry === "string")) {
    return null;
  }

  if (value.cursor !== null && value.cursor !== undefined && parseCursor(value.cursor) === null) return null;
  if (value.editingField !== null && value.editingField !== undefined && parseEditingField(value.editingField) === null) {
    return null;
  }

  return {
    userId: value.userId,
    displayName: value.displayName,
    avatarUrl: value.avatarUrl,
    color: value.color,
    cursor: parseCursor(value.cursor),
    selection: value.selection as string[],
    editingField: parseEditingField(value.editingField),
  };
}

/**
 * The whole reason `AwarenessCursor.containerId` exists on the wire shape:
 * PLAN.md §5's schema comment says it "scopes cursors to an outpost" — a
 * collaborator's cursor should only ever render on *your* canvas when
 * you're both looking at the same container (Job 013's outpost drill-in
 * model, applied to presence the same way it already applies to document
 * content — see `jobs/021-presence.md`'s own framing). `null` (no cursor
 * published, e.g. the peer hasn't moved their mouse over the canvas yet, or
 * just navigated to a different container — see `PresenceCursors.tsx`'s
 * companion "clear cursor on containerId change" behavior) is always
 * invisible, regardless of `viewingContainerId`.
 */
export function isCursorVisibleInContainer(
  cursor: AwarenessCursor | null,
  viewingContainerId: string,
): boolean {
  return cursor !== null && cursor.containerId === viewingContainerId;
}

/** Filters a list of remote Awareness states down to only the ones whose cursor should render from `viewingContainerId` — a thin, testable wrapper around `isCursorVisibleInContainer` for callers that already have a flat `AwarenessState[]` (as opposed to `useRemotePresence.ts`'s `{clientId, state}[]` shape, which filters inline instead). */
export function selectVisibleCursors(
  states: AwarenessState[],
  viewingContainerId: string,
): AwarenessState[] {
  return states.filter((state) => isCursorVisibleInContainer(state.cursor, viewingContainerId));
}
