// The custom edge component behind Job 011's "connection label" and
// "waypoint" gestures (PLAN.md §2's Waypoints row). Registered as
// `edgeTypes = { part: ConnectionEdge }` in `CanvasView.tsx`, matching the
// `type: "part"` `useYjsSync.ts`'s `edgeRecordToFlowEdge` now assigns to
// every edge.
//
// Renders a `[source, ...waypoints, target]` polyline (multi-segment
// routing) through `connectionStyle.ts`'s `buildStyledPathD` — Job 027 wires
// up PLAN.md §3's later-phase "connection style options"
// (Direct/Curves/Horizontal, i.e. straight/bezier/step)
// on top of the same point sequence this job (011) originally rendered as a
// plain straight-segment path.
//
// Later addition — every waypoint (not just a bare, no-waypoint edge) now
// renders as a full icon+rate label (matching the reference Satisfactory
// Modeler app) instead of a small circular dot: `record.part`'s icon plus
// its solved flow rate, or just the part name as text when no solve has
// produced a rate for this edge yet. Every label along one edge shows the
// exact same content (one part, one rate) — only its position differs.
//
// Gesture -> target -> handler map, current rules:
//   drag the bare (no-waypoint) label     -> create the connection's FIRST
//                                             waypoint, live-following the
//                                             cursor as the drag continues.
//                                             This is the *only* way a
//                                             waypoint is ever created by
//                                             dragging — an existing
//                                             waypoint's label can only be
//                                             dragged to *reposition* it,
//                                             never to spawn another one.
//   double-left-click an existing waypoint -> insert one more waypoint
//                                             immediately after it, at the
//                                             midpoint between it and the
//                                             next node/waypoint in the
//                                             direction the parts are
//                                             flowing (source -> waypoints
//                                             in order -> target). This is
//                                             the *only* way to add a
//                                             second-or-later waypoint —
//                                             double-clicking the bare
//                                             label does nothing.
//   double-right-click an existing waypoint -> remove just that waypoint;
//                                             the connection itself is left
//                                             alone.
//   double-right-click the bare label      -> delete the whole connection
//                                             (only reachable when there
//                                             are no waypoints yet — once
//                                             one exists, every label on
//                                             screen belongs to a waypoint,
//                                             per the rule above).
// The bare label and the per-waypoint labels are mutually exclusive in the
// DOM (the bare label only renders while `record.waypoints` is empty), so
// "double-right-click a waypoint" vs. "double-right-click the bare label"
// falls out for free from which element physically exists under the
// cursor, without either handler needing to check the other's state.
import { memo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { parseRational } from "@scm/rational";
import { addWaypoint, getSettings, removeEdge, removeWaypoint, updateWaypoint } from "@scm/ydoc";
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type EdgeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { useCanvasDoc } from "../CanvasDocContext";
import { isDoubleClick, type ClickPoint } from "../doubleClick";
import { formatRate } from "../formatRate";
import { snapPointToGrid } from "../snapToGrid";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasEdge } from "../useYjsSync";
import { buildStyledPathD, resolveConnectionStyle } from "./connectionStyle";
import { buildPolyline, nearestSegmentIndex, pointAtT, type Point } from "./edgeGeometry";

// `transform` is set entirely via inline `style` below (both the
// -50%/-50% centering offset and the flow-position translate need to
// combine into one `transform` value) — deliberately no Tailwind
// `translate-*` utility here, since an inline `style.transform` would just
// clobber it.
const labelClass =
  "nodrag nopan absolute flex cursor-move select-none items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-default)] bg-[var(--surface-overlay)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--text-secondary)] shadow-[var(--shadow-card)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]";

const labelIconClass = "h-4 w-4 shrink-0 object-contain";

/** The bare (no-waypoint) label's position until a real waypoint exists to render at instead — see Handoff notes. */
const DEFAULT_LABEL_POS = 0.5;

/**
 * Screen-pixel move distance (from the initial pointerdown) that turns a
 * bare-label press into a drag-to-create-the-first-waypoint gesture rather
 * than a plain click. Matches `useMarqueeSelection.ts`'s
 * `MARQUEE_DRAG_THRESHOLD_PX` — same "is this actually a drag" question,
 * same answer.
 */
const LABEL_DRAG_THRESHOLD_PX = 4;

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
  // Job 027: document-wide default + per-edge override (`record.style`) —
  // see `connectionStyle.ts`'s header for the precedence rule and the
  // Direct/Curves/Horizontal <-> straight/bezier/step
  // name mapping. Subscribing per-edge-instance mirrors `RecipeNode.tsx`'s
  // own `useSettings(sfmDoc)` call (Job 019's established precedent for
  // "each canvas element reads live settings itself"), not a new pattern.
  const settings = useSettings(sfmDoc);
  // The solver's per-edge computed flow rate — same `SolverResultContext`
  // `RecipeNode.tsx` reads its own rates from. `undefined` whenever nothing
  // has solved a rate for this specific edge yet (None mode, a fresh edge
  // before the first solve lands, etc.), in which case every label falls
  // back to just the part name, same as before this rate was shown at all.
  const { edgeResultById } = useSolverResult();

  // Local optimistic drag state for a waypoint being repositioned — mirrors
  // `useYjsSync.ts`'s node-drag pattern (smooth local movement, single
  // commit to the doc on pointer-up) rather than writing to Yjs on every
  // pointermove. Never creates a waypoint — see this file's header comment.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);
  // Whether the current waypoint-reposition gesture actually moved the
  // pointer at all. Without this, `handleWaypointPointerUp` committed
  // `updateWaypoint` on *every* click (including the two clicks of a
  // double-click), which — beyond being pointless when nothing moved —
  // fires a real Yjs mutation (and the resync/re-solve that follows it) on
  // every single click, which reads as the canvas randomly "recalculating"
  // mid-double-click. Reset on every new press, flipped by the first
  // `pointermove` that actually arrives.
  const hasWaypointDragMovedRef = useRef(false);

  // Local optimistic state for the bare label's own drag-to-create-the-
  // first-waypoint gesture. `labelDragIndex` is the waypoints-array
  // insertion index (same convention as `addWaypoint`'s `index` param) —
  // always `0` in practice, since this gesture only ever runs while
  // `record.waypoints` is still empty, but computed the same way
  // `nearestSegmentIndex` always would rather than hardcoding that. Decided
  // once when the drag crosses `LABEL_DRAG_THRESHOLD_PX` and held fixed for
  // the rest of that drag; `labelDragPoint` tracks the live cursor
  // position. `labelPressRef` holds the pointerdown origin (in screen px)
  // used purely to detect that threshold crossing — a plain ref rather than
  // state since most presses never cross it and shouldn't re-render on
  // every sub-threshold move.
  const [labelDragIndex, setLabelDragIndex] = useState<number | null>(null);
  const [labelDragPoint, setLabelDragPoint] = useState<Point | null>(null);
  const labelPressRef = useRef<{ x: number; y: number } | null>(null);

  // Double-right-click bookkeeping. One ref for the bare label (deletes the
  // whole connection), and one *map* (keyed by waypoint index) for waypoint
  // labels (deletes just that waypoint) — plus a matching map for waypoint
  // double-*left*-click (inserts the next waypoint after it), since each
  // waypoint is an independent click target with its own pair-timing.
  const lastLabelContextClickRef = useRef<ClickPoint | null>(null);
  const lastWaypointClickRef = useRef<Map<number, ClickPoint>>(new Map());
  const lastWaypointContextClickRef = useRef<Map<number, ClickPoint>>(new Map());

  const record = data?.record;
  if (!record) return null; // defensive: `edgeRecordToFlowEdge` always sets `data.record`, but don't crash the canvas if that ever drifts.

  const source: Point = { x: sourceX, y: sourceY };
  const target: Point = { x: targetX, y: targetY };
  const storedWaypoints = record.waypoints;
  // Existing-waypoint drag substitution only — this is what the per-waypoint
  // label `<div>`s below are rendered from, so it deliberately does NOT
  // include the bare-label drag-to-create preview point (that one isn't a
  // committed waypoint yet and has no index of its own to attach handlers
  // to).
  const renderedWaypoints =
    dragIndex !== null && dragPoint ? storedWaypoints.map((w, i) => (i === dragIndex ? dragPoint : w)) : storedWaypoints;
  // Path/geometry view: same substitution, plus the bare-label drag-to-
  // create preview point spliced in at its (fixed-for-the-drag) insertion
  // index so the rendered path bends live as the label is dragged, before
  // anything is actually committed to the doc.
  const pathWaypoints =
    labelDragIndex !== null && labelDragPoint
      ? [...renderedWaypoints.slice(0, labelDragIndex), labelDragPoint, ...renderedWaypoints.slice(labelDragIndex)]
      : renderedWaypoints;

  const points = buildPolyline(source, pathWaypoints, target);
  const effectiveStyle = resolveConnectionStyle(record.style, settings.connectionStyle);
  const pathD = buildStyledPathD(points, effectiveStyle);
  // `pointAtT`'s arc-length walk still operates on the STRAIGHT polyline
  // regardless of rendering style. Only ever used for the bare (no
  // waypoint) label's position now — once a real waypoint exists it's
  // rendered at its own stored `x`/`y` instead, no arc-length math involved.
  const labelPoint = pointAtT(points, record.labelPos ?? DEFAULT_LABEL_POS);
  // While actively drag-creating the first waypoint, the bare label should
  // track the cursor exactly (it's the thing being dragged) rather than its
  // usual arc-length position.
  const displayLabelPoint = labelDragPoint ?? labelPoint;

  // Every label on this edge — the bare one and every waypoint's — shows
  // the same content: the part's icon (like the reference Satisfactory
  // Modeler app) plus the bare rate number, or just the part name as text
  // when no solve has produced a rate for this edge yet.
  const edgeResult = edgeResultById.get(id);
  const iconUrl = getIconUrl(record.part);
  const labelText = edgeResult ? formatRate(parseRational(edgeResult.rate), settings.numberFormats) : record.part;

  /**
   * Inserts a new waypoint immediately after `index`, at the midpoint
   * between it and the next node/waypoint in the direction of flow —
   * `points[index + 1]` is waypoint `index` itself (`points` is
   * `[source, ...waypoints, target]`) and `points[index + 2]` is whatever
   * comes next downstream (the next waypoint, or `target` if `index` was
   * the last one). Deliberately ignores where the double-click physically
   * landed — the insertion point is always this fixed midpoint, not a
   * click position, per this file's header comment.
   */
  function addWaypointAfter(index: number) {
    const a = points[index + 1];
    const b = points[index + 2];
    if (!a || !b) return; // defensive: `index` should always be a valid `storedWaypoints` index here.
    const midpoint: Point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Job 014: snap the *creation* point too, not just subsequent drags —
    // otherwise a freshly-added waypoint would start off-grid and only snap
    // the next time it's dragged, which reads as a bug ("why did it jump")
    // rather than the intended behavior.
    const settings = getSettings(sfmDoc);
    const point = settings.snapWaypoints ? snapPointToGrid(midpoint, settings.gridWaypoint) : midpoint;
    addWaypoint(sfmDoc, id, point, index + 1);
  }

  // Left-button press on the bare label: don't decide drag-vs-click yet
  // (see `handleLabelPointerMove`) — just remember where the press started
  // and keep this element receiving the move/up events even if the cursor
  // wanders off it mid-gesture, same rationale as
  // `handleWaypointPointerDown`'s own `setPointerCapture` call.
  //
  // `stopPropagation()` runs *before* the button check, unconditionally —
  // this element owns every pointer gesture landing on it (left or right
  // button) and must never let one leak past it to the canvas wrapper's own
  // marquee-select pointer handlers (`useMarqueeSelection.ts`, which track
  // *every* right-button press anywhere on the canvas to decide "was this a
  // drag-select or a plain right-click"). A leaked press there — even one
  // that never crosses the marquee's own drag threshold — is what was
  // producing the spurious selection/"recalculating" flicker and, on a
  // second such press right after, the Recipe Chooser opening as if the
  // click had landed on the empty pane.
  function handleLabelPointerDown(event: ReactPointerEvent) {
    event.stopPropagation();
    if (event.button !== 0) return; // right-click falls through to the native contextmenu event (`handleLabelContextMenu`) instead.
    labelPressRef.current = { x: event.clientX, y: event.clientY };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // See `handleWaypointPointerDown`'s identical try/catch — safe to ignore.
    }
  }

  function handleLabelPointerMove(event: ReactPointerEvent) {
    const press = labelPressRef.current;
    if (!press) return;
    event.stopPropagation();
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (labelDragIndex === null) {
      const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      if (distance < LABEL_DRAG_THRESHOLD_PX) return;
      // Decided once, at the moment the drag starts, against the polyline
      // as it stood before this gesture touched it. In practice this is
      // always segment 0 (the bare label only exists while there are no
      // waypoints, i.e. exactly one segment), computed generically rather
      // than hardcoded.
      setLabelDragIndex(nearestSegmentIndex(points, flowPos));
    }
    setLabelDragPoint(flowPos);
  }

  function handleLabelPointerUp(event: ReactPointerEvent) {
    // Unconditional, same reasoning as `handleLabelPointerDown` — this must
    // run before the `press` guard below so even a right-button release
    // (which never set `press`) is still swallowed here.
    event.stopPropagation();
    const press = labelPressRef.current;
    if (!press) return;
    labelPressRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // See `handleWaypointPointerDown`'s identical try/catch — safe to ignore.
    }

    if (labelDragIndex !== null && labelDragPoint) {
      const settings = getSettings(sfmDoc);
      const point = settings.snapWaypoints ? snapPointToGrid(labelDragPoint, settings.gridWaypoint) : labelDragPoint;
      addWaypoint(sfmDoc, id, point, labelDragIndex);
      setLabelDragIndex(null);
      setLabelDragPoint(null);
      return;
    }

    // No threshold crossed — a plain click, which does nothing (the bare
    // label is drag-only for creating a waypoint; double-clicking it no
    // longer does anything, per this file's header comment).
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
      addWaypointAfter(index);
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

  // `stopPropagation()` is unconditional and runs before the button check,
  // same reasoning as `handleLabelPointerDown` above — a waypoint label
  // must swallow every press (including a right-button one, which only
  // ever wants the native contextmenu event below) rather than let it leak
  // to the canvas wrapper's marquee-select pointer handlers.
  function handleWaypointPointerDown(index: number, event: ReactPointerEvent) {
    event.stopPropagation();
    if (event.button !== 0) return; // right-click falls through to the native contextmenu event (`handleWaypointContextMenu`) instead.
    try {
      // Keeps subsequent pointermove/pointerup events targeted at this
      // label even if the cursor moves off it mid-drag. Wrapped
      // defensively: browsers can throw `NotFoundError` here for a pointer
      // id that's already been released by the time this handler runs
      // (observed with synthetic/automated pointer sequences in this job's
      // own manual browser verification) — losing capture just means a
      // fast drag might need the cursor to stay over the label, not a
      // functional break, so it's not worth failing the whole gesture over.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // See above — safe to ignore.
    }
    hasWaypointDragMovedRef.current = false;
    setDragIndex(index);
    setDragPoint(storedWaypoints[index] ?? null);
  }

  function handleWaypointPointerMove(event: ReactPointerEvent) {
    if (dragIndex === null) return;
    event.stopPropagation();
    hasWaypointDragMovedRef.current = true;
    setDragPoint(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  function handleWaypointPointerUp(event: ReactPointerEvent) {
    // Unconditional, same reasoning as `handleLabelPointerUp` — must run
    // before the `dragIndex` guard so a right-button release (which never
    // set `dragIndex`, per the button check above) is still swallowed here
    // instead of reaching the marquee wrapper's own `onPointerUp`.
    event.stopPropagation();
    if (dragIndex === null) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // See `handleWaypointPointerDown`'s identical try/catch — safe to ignore.
    }
    // Only commit if the pointer actually moved — a plain click (both
    // clicks of a double-click included) should never write to the doc.
    // Previously this ran unconditionally, committing a same-value
    // `updateWaypoint` on *every* click, which fired a real Yjs
    // mutation/resync/re-solve on every single click and read as the
    // canvas randomly "recalculating" instead of registering the
    // double-click.
    if (hasWaypointDragMovedRef.current) {
      const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      // Job 014: snap-to-grid on commit, mirroring `useYjsSync.ts`'s
      // `onNodeDragStop` — `Settings.snapWaypoints`/`gridWaypoint` (Job 007's
      // schema) rather than `snapMachines`/`gridMachine`, since PLAN.md §3
      // calls out "snap-to-grid for machines *and* waypoints" as two
      // independently configurable things. Read fresh at the moment the drag
      // ends, same reasoning as that hook's own comment.
      const settings = getSettings(sfmDoc);
      const point = settings.snapWaypoints ? snapPointToGrid(flowPos, settings.gridWaypoint) : flowPos;
      updateWaypoint(sfmDoc, id, dragIndex, point);
    }
    setDragIndex(null);
    setDragPoint(null);
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={pathD}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? "var(--accent)" : "var(--text-muted)",
          strokeWidth: selected ? 2 : 1.5,
          ...style,
        }}
        interactionWidth={16}
      />
      <EdgeLabelRenderer>
        {storedWaypoints.length === 0 && (
          <div
            className={`${labelClass} ${selected ? "border-[var(--accent)] text-[var(--accent)]" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${displayLabelPoint.x}px, ${displayLabelPoint.y}px)`,
              pointerEvents: "all",
              zIndex: EDGE_OVERLAY_Z_INDEX,
            }}
            onPointerDown={handleLabelPointerDown}
            onPointerMove={handleLabelPointerMove}
            onPointerUp={handleLabelPointerUp}
            onContextMenu={handleLabelContextMenu}
            title="Drag to create a waypoint. Double-right-click: delete connection."
          >
            {iconUrl && <img src={iconUrl} alt="" className={labelIconClass} />}
            {labelText}
          </div>
        )}
        {renderedWaypoints.map((point, index) => (
          <div
            // Waypoint identity *is* its array index (that's what
            // `addWaypoint`/`removeWaypoint`/`updateWaypoint` address by) —
            // there's no other stable id to key on.
            key={index}
            className={`${labelClass} ${selected ? "border-[var(--accent)] text-[var(--accent)]" : ""}`}
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
            title="Drag to move. Double-click: insert a waypoint after this one. Double-right-click: remove this waypoint."
          >
            {iconUrl && <img src={iconUrl} alt="" className={labelIconClass} />}
            {labelText}
          </div>
        ))}
      </EdgeLabelRenderer>
    </>
  );
});
