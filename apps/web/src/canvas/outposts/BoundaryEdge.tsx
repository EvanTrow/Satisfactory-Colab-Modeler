// Job 013: the edge component used for a boundary-crossing (projected)
// connection — one endpoint redirected to an outpost's boundary node
// instead of reaching into it (`useYjsSync.ts`'s `CanvasEdgeData.projected`,
// `outposts/visibleGraph.ts`). Deliberately much simpler than
// `edges/ConnectionEdge.tsx` (Job 011): no waypoint dragging, no
// double-click-to-add/remove gestures — the underlying edge's stored
// waypoints belong to whichever container it was originally drawn in
// (generally *not* this one), so they aren't meaningful here, and the
// gestures that mutate them assume they are. A plain, read-only
// smoothstep path plus a part-name label is enough to satisfy this job's
// "correctly shows... a port for that connection" acceptance criterion;
// Job 014's visual pass owns making this prettier.
import { memo } from "react";

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

import type { CanvasEdge } from "../useYjsSync";

const labelClass =
  "pointer-events-none absolute select-none whitespace-nowrap rounded-md border border-[var(--outpost-border)] bg-[var(--surface-overlay)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--outpost)] shadow-[var(--shadow-card)]";

export const BoundaryEdge = memo(function BoundaryEdge({
  data,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  selected,
  markerEnd,
  style,
}: EdgeProps<CanvasEdge>) {
  const record = data?.record;
  if (!record) return null; // defensive: `projectedEdgeToFlowEdge` always sets `data.record`.

  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{ ...style, strokeDasharray: "5 4", stroke: "var(--outpost)", strokeWidth: 1.5, opacity: 0.85 }}
        interactionWidth={16}
      />
      <EdgeLabelRenderer>
        <div
          className={`${labelClass} ${selected ? "border-[var(--accent)] text-[var(--accent)]" : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title="Boundary connection — crosses an outpost's edge. Move the node in/out of the outpost to change this."
        >
          {record.part}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
