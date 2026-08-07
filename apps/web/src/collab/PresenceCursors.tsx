// Job 021: live remote-cursor rendering, **container-scoped** — PLAN.md §5's
// explicit reason `AwarenessCursor.containerId` exists on the wire shape at
// all ("containerId scopes cursors to an outpost"). Mounted inside
// `CanvasView.tsx`'s `CanvasFlow` (which is already inside a
// `<ReactFlowProvider>`, needed here for `useViewport()`), as an absolutely
// positioned sibling of `<ReactFlow>` — not a set of real React Flow nodes,
// since a remote cursor is never something the local user drags/selects/
// connects to, just a purely visual overlay.
//
// Coordinate handling: `AwarenessCursor.x`/`.y` are published in *flow*
// space (`screenToFlowPosition`, the same conversion Job 009's Recipe
// Chooser and Job 011's connection/waypoint code already use — see
// `useCanvasCursorPublisher.ts`), not screen pixels — so this component
// re-projects them back into screen space itself, the same way React Flow's
// own internals position nodes: wrap the cursor markers in a single div
// carrying the exact `translate(viewport.x, viewport.y) scale(viewport.zoom)`
// transform `useViewport()` reports, then position each marker with a plain
// `left`/`top` in flow units inside that transformed div. This keeps cursors
// glued to the correct on-canvas spot through every pan/zoom with zero
// per-frame recomputation here (`useViewport()` itself re-renders this
// component on every viewport change, which is exactly the same mechanism
// `<Background>`'s dot grid relies on).
import { useViewport } from "@xyflow/react";

import { isCursorVisibleInContainer, type AwarenessHandle } from "./awareness";
import { useRemotePresence } from "./useRemotePresence";

export interface PresenceCursorsProps {
  awareness: AwarenessHandle;
  /** The container currently being viewed (`useCanvasDoc().containerId`) — a peer's cursor only renders when their own last-published `cursor.containerId` matches this. */
  containerId: string;
}

export function PresenceCursors({ awareness, containerId }: PresenceCursorsProps) {
  const remote = useRemotePresence(awareness);
  const { x, y, zoom } = useViewport();

  const visible = remote.filter(({ state }) => isCursorVisibleInContainer(state.cursor, containerId));
  if (visible.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})`, transformOrigin: "0 0" }}>
        {visible.map(({ clientId, state }) => (
          <div
            key={clientId}
            className="absolute flex items-center gap-1 will-change-transform"
            style={{
              left: state.cursor!.x,
              top: state.cursor!.y,
              transform: "translate(-2px, -2px)",
            }}
          >
            <svg width="16" height="18" viewBox="0 0 16 18" style={{ filter: "drop-shadow(0 1px 1px rgb(0 0 0 / 0.35))" }}>
              <path d="M1 1 L1 15.5 L5 11.8 L7.6 17.2 L10 16.1 L7.4 10.7 L12.5 10.7 Z" fill={state.color} stroke="white" strokeWidth="1" />
            </svg>
            <span
              className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
              style={{ backgroundColor: state.color }}
            >
              {state.displayName}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
