// The custom edge component behind Job 011's "connection label" and
// "waypoint" gestures (PLAN.md §2's Waypoints row). Registered as
// `edgeTypes = { part: ConnectionEdge }` in `CanvasView.tsx`, matching the
// `type: "part"` `useYjsSync.ts`'s `edgeRecordToFlowEdge` now assigns to
// every edge.
//
// Renders a straight-segment polyline through `[source, ...waypoints,
// target]` (multi-segment routing — Job 014 owns curve/step visual style
// per PLAN.md §3's later-phase "connection style options"), plus:
//   - one small draggable marker per waypoint, and
//   - a single label (the edge's `part` name) positioned at `labelPos`
//     (a 0..1 arc-length t-parameter — see Handoff notes for why this
//     confirms rather than changes Job 007's assumed convention).
//
// Gesture -> target -> handler map (PLAN.md §2's Waypoints row, verbatim):
//   double-left-click label or waypoint  -> add a waypoint at that position
//   double-right-click a waypoint        -> delete just that waypoint
//   double-right-click a bare label      -> delete the whole connection
// "Bare label" (no waypoint under the cursor) falls out for free from plain
// DOM event targeting: the label and each waypoint are separate elements
// with their own `onContextMenu` handlers and `stopPropagation()`, so a
// right-click physically over a waypoint marker is caught by that marker's
// own handler and never reaches the label's.
import { memo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { addWaypoint, removeEdge, removeWaypoint, updateWaypoint } from "@scm/ydoc";
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type EdgeProps } from "@xyflow/react";

import { useCanvasDoc } from "../CanvasDocContext";
import { isDoubleClick, type ClickPoint } from "../doubleClick";
import type { CanvasEdge } from "../useYjsSync";
import { buildPolyline, nearestSegmentIndex, pointAtT, toPathD, type Point } from "./edgeGeometry";

// `transform` is set entirely via inline `style` below (both the
// -50%/-50% centering offset and the flow-position translate need to
// combine into one `transform` value) — deliberately no Tailwind
// `translate-*` utility here, since an inline `style.transform` would just
// clobber it.
const waypointMarkerClass =
  "nodrag nopan absolute h-2.5 w-2.5 cursor-move rounded-full border border-neutral-300 bg-neutral-600 hover:bg-indigo-500";

const labelClass =
  "nodrag nopan absolute cursor-pointer select-none whitespace-nowrap rounded border border-neutral-600 bg-neutral-900/90 px-1 py-0.5 text-[10px] text-neutral-200 hover:border-indigo-500";

/** The default `labelPos` used until a waypoint-adding click establishes a real one — see Handoff notes. */
const DEFAULT_LABEL_POS = 0.5;

/**
 * React Flow assigns every `.react-flow__node` an inline `z-index: 1000`
 * (verified live via `getComputedStyle`/the node's own `style` attribute
 * during this job's manual browser verification), and `EdgeLabelRenderer`'s
 * container is a DOM sibling of the nodes container that comes *before* it
 * in `.react-flow__viewport`'s children — so with no z-index of its own, a
 * label/waypoint sitting at a screen position that overlaps a node (common:
 * a short edge's midpoint label frequently lands on or near one of its own
 * two endpoint nodes) silently loses every hit-test to that node and
 * becomes unclickable. Confirmed by direct `document.elementFromPoint`/
 * `elementsFromPoint` comparison against the live DOM: without this,
 * `hit === labelDiv` was `false` even at the label's own geometric center.
 * Comfortably above 1000 so it always wins regardless of any
 * selection/drag-driven z-index bump React Flow gives a node.
 */
const EDGE_OVERLAY_Z_INDEX = 10000;

export const ConnectionEdge = memo(function ConnectionEdge({
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
  const { screenToFlowPosition } = useReactFlow();

  // Local optimistic drag state for a waypoint being dragged — mirrors
  // `useYjsSync.ts`'s node-drag pattern (smooth local movement, single
  // commit to the doc on pointer-up) rather than writing to Yjs on every
  // pointermove.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);

  // Double-click/double-right-click bookkeeping. One ref for the label,
  // and one *map* (keyed by waypoint index) for waypoint markers, since
  // each waypoint is an independent click target with its own pair-timing.
  const lastLabelClickRef = useRef<ClickPoint | null>(null);
  const lastLabelContextClickRef = useRef<ClickPoint | null>(null);
  const lastWaypointClickRef = useRef<Map<number, ClickPoint>>(new Map());
  const lastWaypointContextClickRef = useRef<Map<number, ClickPoint>>(new Map());

  const record = data?.record;
  if (!record) return null; // defensive: `edgeRecordToFlowEdge` always sets `data.record`, but don't crash the canvas if that ever drifts.

  const source: Point = { x: sourceX, y: sourceY };
  const target: Point = { x: targetX, y: targetY };
  const storedWaypoints = record.waypoints;
  const renderedWaypoints =
    dragIndex !== null && dragPoint ? storedWaypoints.map((w, i) => (i === dragIndex ? dragPoint : w)) : storedWaypoints;

  const points = buildPolyline(source, renderedWaypoints, target);
  const pathD = toPathD(points);
  const labelPoint = pointAtT(points, record.labelPos ?? DEFAULT_LABEL_POS);

  function addWaypointAtClient(clientX: number, clientY: number) {
    const flowPos = screenToFlowPosition({ x: clientX, y: clientY });
    const index = nearestSegmentIndex(points, flowPos);
    addWaypoint(sfmDoc, id, flowPos, index);
  }

  function handleLabelClick(event: ReactMouseEvent) {
    event.stopPropagation();
    const now: ClickPoint = { time: Date.now(), x: event.clientX, y: event.clientY };
    if (isDoubleClick(lastLabelClickRef.current, now)) {
      lastLabelClickRef.current = null;
      addWaypointAtClient(event.clientX, event.clientY);
    } else {
      lastLabelClickRef.current = now;
    }
  }

  function handleLabelContextMenu(event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const now: ClickPoint = { time: Date.now(), x: event.clientX, y: event.clientY };
    if (isDoubleClick(lastLabelContextClickRef.current, now)) {
      lastLabelContextClickRef.current = null;
      removeEdge(sfmDoc, id);
    } else {
      lastLabelContextClickRef.current = now;
    }
  }

  function handleWaypointClick(index: number, event: ReactMouseEvent) {
    event.stopPropagation();
    const now: ClickPoint = { time: Date.now(), x: event.clientX, y: event.clientY };
    const last = lastWaypointClickRef.current.get(index) ?? null;
    if (isDoubleClick(last, now)) {
      lastWaypointClickRef.current.delete(index);
      addWaypointAtClient(event.clientX, event.clientY);
    } else {
      lastWaypointClickRef.current.set(index, now);
    }
  }

  function handleWaypointContextMenu(index: number, event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const now: ClickPoint = { time: Date.now(), x: event.clientX, y: event.clientY };
    const last = lastWaypointContextClickRef.current.get(index) ?? null;
    if (isDoubleClick(last, now)) {
      lastWaypointContextClickRef.current.delete(index);
      removeWaypoint(sfmDoc, id, index);
    } else {
      lastWaypointContextClickRef.current.set(index, now);
    }
  }

  function handleWaypointPointerDown(index: number, event: ReactPointerEvent) {
    event.stopPropagation();
    try {
      // Keeps subsequent pointermove/pointerup events targeted at this
      // marker even if the cursor moves off its small hit area mid-drag.
      // Wrapped defensively: browsers can throw `NotFoundError` here for a
      // pointer id that's already been released by the time this handler
      // runs (observed with synthetic/automated pointer sequences in this
      // job's own manual browser verification) — losing capture just means
      // a fast drag might need the cursor to stay over the marker, not a
      // functional break, so it's not worth failing the whole gesture over.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // See above — safe to ignore.
    }
    setDragIndex(index);
    setDragPoint(storedWaypoints[index] ?? null);
  }

  function handleWaypointPointerMove(event: ReactPointerEvent) {
    if (dragIndex === null) return;
    setDragPoint(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  function handleWaypointPointerUp(event: ReactPointerEvent) {
    if (dragIndex === null) return;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    updateWaypoint(sfmDoc, id, dragIndex, flowPos);
    setDragIndex(null);
    setDragPoint(null);
  }

  return (
    <>
      <BaseEdge id={id} path={pathD} markerEnd={markerEnd} style={style} interactionWidth={16} />
      <EdgeLabelRenderer>
        <div
          className={`${labelClass} ${selected ? "border-indigo-500" : ""}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelPoint.x}px, ${labelPoint.y}px)`,
            pointerEvents: "all",
            zIndex: EDGE_OVERLAY_Z_INDEX,
          }}
          onClick={handleLabelClick}
          onContextMenu={handleLabelContextMenu}
          title="Double-click: add waypoint here. Double-right-click: delete connection."
        >
          {record.part}
        </div>
        {renderedWaypoints.map((point, index) => (
          <div
            // Waypoint identity *is* its array index (that's what
            // `addWaypoint`/`removeWaypoint`/`updateWaypoint` address by) —
            // there's no other stable id to key on.
            key={index}
            className={waypointMarkerClass}
            style={{
              transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)`,
              pointerEvents: "all",
              zIndex: EDGE_OVERLAY_Z_INDEX + 1,
            }}
            onClick={(event) => handleWaypointClick(index, event)}
            onContextMenu={(event) => handleWaypointContextMenu(index, event)}
            onPointerDown={(event) => handleWaypointPointerDown(index, event)}
            onPointerMove={handleWaypointPointerMove}
            onPointerUp={handleWaypointPointerUp}
            title="Drag to move. Double-click: add another waypoint here. Double-right-click: delete this waypoint."
          />
        ))}
      </EdgeLabelRenderer>
    </>
  );
});
