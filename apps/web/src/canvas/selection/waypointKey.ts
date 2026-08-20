// Waypoints have no id of their own (`EdgeRecord.waypoints` is a plain
// array — `ConnectionEdge.tsx`'s own gestures already address a waypoint by
// `(edgeId, index)`, e.g. `updateWaypoint(sfmDoc, edgeId, index, point)`).
// Marquee-selecting waypoints needs a single hashable identity to put in a
// `Set<string>` (`selectedWaypoints`, threaded through `CanvasDocContext`),
// so this pure module is the one place that encodes/decodes that pair —
// every other file works with `{ edgeId, index }` directly and only touches
// the string form at the Set boundary.
const SEPARATOR = "::"; // not a legal character in a `@scm/ydoc` edge id (a UUID) or in a base-10 index, so this can't collide.

export function waypointKey(edgeId: string, index: number): string {
  return `${edgeId}${SEPARATOR}${index}`;
}

export interface ParsedWaypointKey {
  edgeId: string;
  index: number;
}

/** Inverse of `waypointKey` — `null` for anything that isn't a well-formed `waypointKey(...)` output (defensive: `selectedWaypoints` is plain `string`s, not a branded type, so a caller could in principle hand this something else). Uses `lastIndexOf` (not `split`) so an edge id that somehow contained the separator itself wouldn't misparse — `@scm/ydoc` ids are UUIDs today and never will, but the index is always the *last* segment either way. */
export function parseWaypointKey(key: string): ParsedWaypointKey | null {
  const sepIndex = key.lastIndexOf(SEPARATOR);
  if (sepIndex === -1) return null;
  const edgeId = key.slice(0, sepIndex);
  const indexPart = key.slice(sepIndex + SEPARATOR.length);
  if (!edgeId) return null;
  if (!/^\d+$/.test(indexPart)) return null;
  return { edgeId, index: Number(indexPart) };
}
