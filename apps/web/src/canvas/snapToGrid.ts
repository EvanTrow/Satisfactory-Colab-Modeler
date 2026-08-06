// Pure snap-to-grid math (Job 014). Deliberately extracted into its own
// dependency-free module — same pattern `nodes/recipeNodeMath.ts` (Job 010)
// established for logic worth unit-testing without a React/Yjs harness — so
// `apps/web`'s node-environment-only Vitest setup (`vitest.config.ts`'s own
// comment: "no React/DOM testing set up") can exercise it directly.
//
// Consumers (both read `@scm/ydoc`'s `Settings.snapMachines`/`gridMachine`
// or `Settings.snapWaypoints`/`gridWaypoint` themselves, via `getSettings`,
// and only call into this module for the arithmetic):
//   - `useYjsSync.ts`'s `onNodeDragStop` — snaps a real node's `x`/`y`
//     (`moveNode`) and an outpost boundary node's `x`/`y` (`updateContainer`)
//     the same way, since both are plain canvas positions.
//   - `edges/ConnectionEdge.tsx`'s `handleWaypointPointerUp` — snaps a
//     waypoint's committed position (`updateWaypoint`).

/** A grid size of 0 (or negative — not expected from real `Settings`, but defensive) disables snapping for that axis rather than dividing by zero. */
export function snapToGrid(value: number, gridSize: number): number {
  if (!Number.isFinite(gridSize) || gridSize <= 0) return value;
  return Math.round(value / gridSize) * gridSize;
}

export interface GridSize {
  x: number;
  y: number;
}

export interface GridPoint {
  x: number;
  y: number;
}

/** Snaps both axes of a point independently — `gridMachine`/`gridWaypoint` are stored as independent x/y sizes, not assumed square. */
export function snapPointToGrid(point: GridPoint, grid: GridSize): GridPoint {
  return { x: snapToGrid(point.x, grid.x), y: snapToGrid(point.y, grid.y) };
}
