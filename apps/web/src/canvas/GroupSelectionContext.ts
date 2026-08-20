// Marquee-selected waypoints (`selection/waypointKey.ts`) and the live
// "group drag" delta that carries them along with a node/waypoint drag —
// kept in its OWN context, separate from `CanvasDocContext.ts`, for the
// same reason `SolverResultContext.ts` is its own file: `waypointGroupDragDelta`
// changes on every frame of an active group drag, and putting it on the
// broad `CanvasDocContext` (consumed by every node/edge/panel under
// `<CanvasView>`) would force ALL of them to re-render on every such frame
// via React's own "a changed context always re-renders every consumer,
// `memo()` or not" propagation rule — not just the `ConnectionEdge`
// instances that actually have a stake in it. Only components that call
// `useGroupSelection()` — `ConnectionEdge.tsx` and `CanvasView.tsx`'s
// `CanvasFlow` — re-render when this value changes, and in the common case
// (nothing selected, or a plain single-node/single-waypoint drag with no
// selection overlap) it never changes at all.
import { createContext, useContext } from "react";

export interface GroupSelectionContextValue {
  /**
   * Marquee-selected waypoints, as `waypointKey(edgeId, index)` strings —
   * the waypoint-level sibling of React Flow's own `node.selected`/
   * `edge.selected`, since a waypoint isn't a first-class flow element and
   * has no `selected` flag of its own to carry. Populated wholesale by
   * `useMarqueeSelection.ts`'s right-click-drag gesture (replaced, not
   * merged, on every completed marquee — matching how it already treats
   * node/edge selection); read by `ConnectionEdge.tsx` (selection outline,
   * and whether ITS OWN waypoint drag should drag the whole group) and by
   * `CanvasView.tsx`'s `CanvasFlow` (whether a NODE drag should carry
   * selected waypoints along too).
   */
  selectedWaypoints: Set<string>;
  setSelectedWaypoints: (keys: Set<string>) => void;
  /**
   * Live (per-frame, pre-commit) delta the current group drag has moved so
   * far, in flow units — set by whichever gesture is driving the group (a
   * node drag, in `CanvasFlow`, or a waypoint drag, in `ConnectionEdge.tsx`)
   * and read by every `ConnectionEdge` to preview its own
   * selected-but-not-directly-grabbed waypoints shifting along with it.
   * `null` while no such group drag is in progress.
   */
  waypointGroupDragDelta: { dx: number; dy: number } | null;
  setWaypointGroupDragDelta: (delta: { dx: number; dy: number } | null) => void;
  /**
   * The node-moving half of a WAYPOINT-initiated group drag — when the
   * user grabs a selected waypoint and the current selection also includes
   * nodes, `ConnectionEdge.tsx` calls `preview` on every move (live,
   * broadcast to remote peers exactly like a normal node drag) and
   * `commit` once at drag-end (writes `moveNode`/`updateContainer` for
   * every currently-selected node). A NODE-initiated group drag needs no
   * such callback the other way — React Flow already moves every selected
   * node natively; only the waypoint side needs help there (see
   * `CanvasFlow`'s own `handleNodesChange`/`handleNodeDragStop`).
   */
  groupNodeMove: {
    preview: (dx: number, dy: number) => void;
    commit: () => void;
  };
}

export const GroupSelectionContext = createContext<GroupSelectionContextValue | null>(null);

/** Throws if called outside a `<CanvasView>` subtree — same fail-fast pattern `useCanvasDoc()`/`useSolverResult()` already use. */
export function useGroupSelection(): GroupSelectionContextValue {
  const value = useContext(GroupSelectionContext);
  if (!value) {
    throw new Error("useGroupSelection() must be called underneath <CanvasView>");
  }
  return value;
}
