// Job 013: the edge component used for a boundary-crossing (projected)
// connection — one endpoint redirected to an outpost's boundary node
// instead of reaching into it (`useYjsSync.ts`'s `CanvasEdgeData.projected`,
// `outposts/visibleGraph.ts`). Deliberately much simpler than
// `edges/ConnectionEdge.tsx` (Job 011): no waypoint dragging, no
// double-click-to-add/remove gestures — the underlying edge's stored
// waypoints belong to whichever container it was originally drawn in
// (generally *not* this one), so they aren't meaningful here, and the
// gestures that mutate them assume they are. A plain, read-only path plus a
// part-name label is enough to satisfy this job's "correctly shows... a
// port for that connection" acceptance criterion; Job 014's visual pass owns
// making this prettier.
//
// Outpost I/O rework: the PATH itself now honors `Settings.connectionStyle`/
// `EdgeRecord.style` the same way `ConnectionEdge.tsx` does — via
// `edges/connectionStyle.ts`'s `resolveConnectionStyle`/`buildStyledPathD`,
// just with an empty waypoint list (this edge's own stored waypoints aren't
// meaningful here, per this file's header — but the STYLE choice needs no
// waypoints to apply, `buildStyledPathD`'s 2-point case handles a bare
// source-to-target run for straight/bezier/step alike). Previously hardcoded
// `getSmoothStepPath`, ignoring the setting entirely — a small gap when
// boundary crossings were rare, but now the primary way an outpost/blueprint
// connects to anything, so it needed to actually follow the setting.
//
// Calculation-validation visuals pass: this edge's `id` prop is always the
// real, un-rewritten `EdgeRecord.id` (`useYjsSync.ts`'s
// `projectedEdgeToFlowEdge`: `id: projected.record.id` — the *projection*
// changes where it visually terminates, never its identity), the exact same
// id `edgeResultById` is keyed by (including, since the outpost I/O rework,
// an alias to the synthetic pass-through result when this edge touches a
// locked Inputs/Outputs node — see `useSolver.ts`'s `indexEdges`). So this
// can look up the same `EdgeSolveResult` `ConnectionEdge.tsx` does and color
// the stroke the same way, instead of always hardcoding the outpost amber.
import { memo } from "react";

import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { useCanvasDoc } from "../CanvasDocContext";
import { classifyEdgeValidity } from "../edges/classifyEdgeValidity";
import { buildStyledPathD, resolveConnectionStyle } from "../edges/connectionStyle";
import { buildPolyline, pointAtT } from "../edges/edgeGeometry";
import { formatRate, resolveEdgeRate } from "../formatRate";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasEdge } from "../useYjsSync";

const labelClass =
  "pointer-events-none absolute flex select-none items-center gap-1 whitespace-nowrap rounded-md border border-[var(--outpost-border)] bg-[var(--surface-overlay)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--outpost)] shadow-[var(--shadow-card)]";
const labelIconClass = "h-3.5 w-3.5 shrink-0 object-contain";

/** `"invalid"`/`"mismatched"` -> the same stroke colors `ConnectionEdge.tsx` uses; `"valid"`/`"unknown"` -> `undefined`, i.e. keep the outpost amber. */
function strokeColorFor(validity: ReturnType<typeof classifyEdgeValidity>): string | undefined {
  if (validity === "invalid") return "var(--danger)";
  if (validity === "mismatched") return "var(--mismatch)";
  return undefined;
}

export const BoundaryEdge = memo(function BoundaryEdge({
  id,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
  markerEnd,
  style,
}: EdgeProps<CanvasEdge>) {
  const { sfmDoc } = useCanvasDoc();
  const { edgeResultById, nodeResultById } = useSolverResult();
  const settings = useSettings(sfmDoc);
  const record = data?.record;
  if (!record) return null; // defensive: `projectedEdgeToFlowEdge` always sets `data.record`.

  const points = buildPolyline({ x: sourceX, y: sourceY }, [], { x: targetX, y: targetY });
  const effectiveStyle = resolveConnectionStyle(record.style, settings.connectionStyle);
  const path = buildStyledPathD(points, effectiveStyle);
  // Same "arc-length walk over the straight polyline regardless of
  // rendering style" convention `ConnectionEdge.tsx`'s bare-label position
  // uses — a fixed midpoint (0.5) since this edge has no `labelPos` gesture
  // of its own (read-only, per this file's header).
  const { x: labelX, y: labelY } = pointAtT(points, 0.5);
  const edgeResult = edgeResultById.get(id);
  const validity = classifyEdgeValidity(edgeResult);
  const validityStroke = strokeColorFor(validity);
  // Same icon + rate label content `ConnectionEdge.tsx` shows — this edge's
  // `id` is the real, un-rewritten edge id, already resolved to a real
  // `EdgeSolveResult` via `useSolver.ts`'s aliasing (this file's header) for
  // a connection touching a locked Inputs/Outputs node, exactly like any
  // other connection. `resolveEdgeRate` additionally falls back to whichever
  // real endpoint's own party rate when there's no complete circuit yet
  // (`formatRate.ts`'s own doc comment) — the same fallback the outpost/
  // blueprint card's own rows already show, so a still-one-sided connection
  // doesn't read as "no idea" on the wire while the card right next to it
  // shows a number.
  const iconUrl = getIconUrl(record.part);
  const resolvedRate = resolveEdgeRate(record, edgeResultById, nodeResultById);
  const labelText = resolvedRate ? formatRate(resolvedRate, settings.numberFormats) : record.part;

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeDasharray: "5 4",
          stroke: validityStroke ?? "var(--outpost)",
          strokeWidth: validityStroke ? 2.5 : 1.5,
          opacity: 0.85,
        }}
        interactionWidth={16}
      />
      <EdgeLabelRenderer>
        <div
          className={`${labelClass} ${selected ? "border-[var(--accent)] text-[var(--accent)]" : ""}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            ...(validityStroke ? { borderColor: validityStroke, color: validityStroke } : {}),
          }}
          title="Boundary connection — crosses an outpost's edge. Move the node in/out of the outpost to change this."
        >
          {iconUrl && <img src={iconUrl} alt="" className={labelIconClass} draggable={false} />}
          {labelText}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
