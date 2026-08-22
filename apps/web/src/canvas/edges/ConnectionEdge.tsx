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
import {
  memo,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import {
  addWaypoint,
  getEdge,
  getNode,
  getSettings,
  removeEdge,
  removeWaypoint,
  updateWaypoint,
} from "@scm/ydoc";
import {
  BaseEdge,
  EdgeLabelRenderer,
  useInternalNode,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { createThrottled, useEdgeDragPublisher, type AwarenessCursor } from "../../collab";
import { useCanvasDoc } from "../CanvasDocContext";
import { isDoubleClick, type ClickPoint } from "../doubleClick";
import { formatRate, resolveEdgeRate } from "../formatRate";
import { useGroupSelection } from "../GroupSelectionContext";
import { computeMismatchDetails } from "../nodes/computeMismatchDetails";
import { parseWaypointKey, waypointKey } from "../selection";
import { snapPointToGrid } from "../snapToGrid";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasEdge } from "../useYjsSync";
import { classifyEdgeValidity, type EdgeValidity } from "./classifyEdgeValidity";
import { buildStyledPathD, resolveConnectionStyle } from "./connectionStyle";
import { buildPolyline, nearestSegmentIndex, pointAtT, type Point } from "./edgeGeometry";

/** `"invalid"`/`"mismatched"` -> the same red/orange every other validity indicator in this app uses; `"valid"`/`"unknown"` -> `undefined` (keep this edge's normal muted/accent look). */
function strokeColorFor(validity: EdgeValidity): string | undefined {
  if (validity === "invalid") return "var(--danger)";
  if (validity === "mismatched") return "var(--mismatch)";
  return undefined;
}

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

/**
 * Same cadence as `useCursorPublisher.ts`'s own `CURSOR_PUBLISH_INTERVAL_MS`
 * — see this file's `throttledSetCursor` for why a second, local throttled
 * cursor publisher exists here at all rather than reusing that hook's.
 */
const CURSOR_PUBLISH_INTERVAL_MS = 50;

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
  const { sfmDoc, containerId, localPresence } = useCanvasDoc();
  // Marquee-selected waypoints + the group-drag machinery that carries
  // them (and any selected nodes) along with this edge's own gestures —
  // see `GroupSelectionContext.ts`'s header comment for why this is a
  // separate, narrower context from `useCanvasDoc()`.
  const { selectedWaypoints, waypointGroupDragDelta, setWaypointGroupDragDelta, groupNodeMove } =
    useGroupSelection();
  const { screenToFlowPosition } = useReactFlow();
  const { t } = useTranslation("app");
  // Live drag broadcasting for this edge's own waypoint/label gestures —
  // the connection-level sibling of `CanvasView.tsx`'s node-drag broadcast.
  // One publisher per `ConnectionEdge` instance (unlike the single
  // canvas-wide node one) since each edge owns its own independent drag.
  const edgeDragPublisher = useEdgeDragPublisher(localPresence.setEdgeDragging, containerId, id);
  // A waypoint/label drag's `stopPropagation()` calls below (needed so the
  // gesture doesn't leak into the canvas wrapper's own marquee-select
  // pointer handlers — see `handleLabelPointerDown`'s doc comment) have a
  // real side effect: they *also* stop the same pointer event from ever
  // reaching `CanvasView.tsx`'s wrapper `onPointerMove`, which is what
  // publishes this client's own live cursor position
  // (`useCursorPublisher.ts`). Without a second publish call here, this
  // client's cursor visibly freezes — from every OTHER peer's point of
  // view — for the whole duration of a waypoint/label drag, the exact same
  // failure mode `useCursorPublisher.ts`'s header comment documents for
  // node dragging (there, the culprit was `d3-drag`'s own event handling;
  // here, it's this file's own `stopPropagation()` calls). Same throttle
  // cadence as that hook, kept as its own local instance rather than a
  // shared one since each `ConnectionEdge` needs its own independent
  // throttle window.
  const throttledSetCursor = useMemo(
    () =>
      createThrottled(
        (cursor: AwarenessCursor) => localPresence.setCursor(cursor),
        CURSOR_PUBLISH_INTERVAL_MS,
      ),
    [localPresence.setCursor],
  );
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
  const { edgeResultById, nodeResultById } = useSolverResult();

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

  // Public-link work: `CanvasView.tsx`'s `CanvasFlow` sets this on every
  // edge's `data` for a read-only public viewer (`useYjsSync.ts`'s
  // `CanvasEdgeData.readOnly`) — none of this component's own gestures
  // (create/move/delete a waypoint, delete the connection) go through React
  // Flow's `nodesDraggable`/`elementsSelectable` props at all, they're all
  // handled by this component's own pointer/click handlers below, so they
  // need their own explicit guard rather than inheriting one from
  // `<ReactFlow>`.
  const readOnly = Boolean(data?.readOnly);
  const record = data?.record;
  // Live (per-frame, pre-commit) positions of this edge's two endpoint
  // nodes — called unconditionally (hooks can't follow the `!record` early
  // return below) with a harmless `""` fallback id on the defensive
  // no-record path, which `nodeLookup.get("")` just resolves to `undefined`.
  // This is what lets the waypoints below track a node drag (local OR
  // remote) live instead of jumping into place only once `onNodeDragStop`
  // (`useYjsSync.ts`) commits the final position to the doc — see the
  // `liveDelta` comment further down for why this only kicks in while
  // *both* endpoints currently sit away from their persisted position.
  const fromNodeLive = useInternalNode(record?.fromNode ?? "");
  const toNodeLive = useInternalNode(record?.toNode ?? "");
  if (!record) return null; // defensive: `edgeRecordToFlowEdge` always sets `data.record`, but don't crash the canvas if that ever drifts.
  // Hoisted out of `record` so `handleWaypointPointerMove`/`handleWaypointPointerUp`
  // below can read it without TypeScript losing the `!record` narrowing —
  // control-flow narrowing from an early return doesn't extend into a
  // nested function declaration's body, even though `record` itself is
  // never reassigned.
  const persistedWaypoints = record.waypoints;

  const source: Point = { x: sourceX, y: sourceY };
  const target: Point = { x: targetX, y: targetY };
  // A waypoint is a fixed point in the container's coordinate space, not
  // relative to either endpoint (mirrors `useYjsSync.ts`'s `onNodeDragStop`
  // doc comment on the same point) — so it only needs to move at all when
  // *both* of this edge's endpoints are mid-drag together (a multi-selection
  // group drag, moving the whole edge as a rigid unit with nothing about its
  // routing actually changing). `fromNodeLive`/`toNodeLive`'s `.position` is
  // React Flow's own live (per-frame) node position — the exact same value
  // `sourceX`/`sourceY`/`targetX`/`targetY` above are derived from, and
  // (Live drag broadcasting) the exact same value `CanvasView.tsx`'s
  // `CanvasFlow` overrides for a node a REMOTE peer is currently dragging
  // (`renderedNodes`, fed into `<ReactFlow nodes={...}>`) — so comparing it
  // against the *persisted* (pre-drag, since `moveNode`/a remote peer's own
  // `onNodeDragStop` only commits at THEIR drag-stop) doc position gives the
  // right on-screen delta for a LOCAL drag and a REMOTE one alike, with no
  // separate remote-specific code path needed: this file doesn't need to
  // know or care which peer is doing the dragging, only that BOTH endpoints
  // currently sit some consistent offset away from their persisted spot.
  // Once the drag ends (locally or remotely), the mover's own
  // `onNodeDragStop` commits both the final node positions *and* this same
  // delta into the waypoints themselves, so `record.waypoints` already
  // reflects it by the time this live offset naturally settles back to
  // zero (`fromNodeLive.position` converges back onto `fromPersisted`).
  //
  // Deliberately NOT gated on React Flow's own internal `node.dragging` flag
  // (an earlier version of this code was) — that flag only ever reflects a
  // LOCAL pointer-drag gesture, so it silently never lit up for a remote
  // peer's broadcast position, which is why waypoints weren't following a
  // remote drag. Comparing live-vs-persisted position directly works for
  // both without needing to know which one is happening.
  let liveDelta = { dx: 0, dy: 0 };
  if (fromNodeLive && toNodeLive) {
    const fromPersisted = getNode(sfmDoc, record.fromNode);
    const toPersisted = getNode(sfmDoc, record.toNode);
    if (fromPersisted && toPersisted) {
      const fromDx = fromNodeLive.position.x - fromPersisted.x;
      const fromDy = fromNodeLive.position.y - fromPersisted.y;
      const toDx = toNodeLive.position.x - toPersisted.x;
      const toDy = toNodeLive.position.y - toPersisted.y;
      // "Rigid move" = both endpoints currently sit the same offset away
      // from their persisted spot (within a fraction of a pixel, to absorb
      // float rounding — not an exact-equality gate) AND that offset is
      // actually non-zero. A single-endpoint drag (only one side offset)
      // deliberately leaves `liveDelta` at zero, same as before.
      const isRigidMove =
        Math.abs(fromDx - toDx) < 0.5 &&
        Math.abs(fromDy - toDy) < 0.5 &&
        (Math.abs(fromDx) > 0.01 || Math.abs(fromDy) > 0.01);
      if (isRigidMove) {
        liveDelta = { dx: fromDx, dy: fromDy };
      }
    }
  }
  const storedWaypoints =
    liveDelta.dx !== 0 || liveDelta.dy !== 0
      ? record.waypoints.map((w) => ({ x: w.x + liveDelta.dx, y: w.y + liveDelta.dy }))
      : record.waypoints;
  // Live drag broadcasting: a remote peer's own in-flight waypoint/label
  // drag on THIS edge (`CanvasView.tsx`'s `CanvasFlow`, sourced from their
  // Awareness `edgeDragging` field) — rendered through the exact same
  // substitution/splice logic below as this client's OWN local drag state
  // (`dragIndex`/`dragPoint`, `labelDragIndex`/`labelDragPoint`), just a
  // different data source. Local always wins if somehow both are active on
  // the same edge at once (shouldn't normally happen — a person only drags
  // their own cursor).
  const remoteWaypointDrag = data?.remoteWaypointDrag;
  // The group-drag sibling of `remoteWaypointDrag` above: waypoints a
  // REMOTE peer's own node-driven GROUP drag (their marquee selection —
  // pure per-client UI state, never synced) is carrying along, keyed by
  // index — see `useYjsSync.ts`'s `CanvasEdgeData.remoteGroupWaypoints` doc
  // comment for why a viewer needs this broadcast at all rather than
  // reading its OWN `selectedWaypoints`.
  const remoteGroupWaypoints = data?.remoteGroupWaypoints;
  // Existing-waypoint drag substitution only — this is what the per-waypoint
  // label `<div>`s below are rendered from, so it deliberately does NOT
  // include the bare-label drag-to-create preview point (that one isn't a
  // committed waypoint yet and has no index of its own to attach handlers
  // to). Four independent sources, checked in priority order per index:
  // (1) THIS client's own direct drag of that exact waypoint — always wins.
  // (2) a REMOTE peer's own direct drag of that exact waypoint.
  // (3) a REMOTE peer's node-driven GROUP drag carrying this waypoint along.
  // (4) this waypoint being marquee-SELECTED (not directly grabbed by
  //     anyone) while a LOCAL group drag is in progress elsewhere on the
  //     selection — `CanvasView.tsx`'s `CanvasFlow` (a node driving the
  //     group) or this same file's `handleWaypointPointerMove` (another
  //     waypoint driving it) publish `waypointGroupDragDelta` for exactly
  //     this case. `persistedWaypoints[index]`, not `storedWaypoints[index]`,
  //     is the origin here deliberately — the two-endpoint-rigid-move
  //     `liveDelta` above and this group delta are two independent reasons
  //     a waypoint can be moving at once and must never compound.
  const renderedWaypoints = storedWaypoints.map((point, index) => {
    if (index === dragIndex && dragPoint) return dragPoint;
    if (remoteWaypointDrag?.mode === "move" && remoteWaypointDrag.waypointIndex === index) {
      return { x: remoteWaypointDrag.x, y: remoteWaypointDrag.y };
    }
    const remoteGroupPosition = remoteGroupWaypoints?.get(index);
    if (remoteGroupPosition) return remoteGroupPosition;
    // `liveDelta` (the two-endpoint-rigid-move case, above) already shifted
    // `point` via `storedWaypoints` — a marquee selection that ALSO covers
    // both of this edge's endpoint nodes would make BOTH conditions true at
    // once, so this only applies the group delta when `liveDelta` is NOT
    // already covering the same waypoint, and reads from `record.waypoints`
    // (the true persisted origin) rather than the possibly-already-shifted
    // `point`, so the two mechanisms can never compound into a double shift.
    if (
      liveDelta.dx === 0 &&
      liveDelta.dy === 0 &&
      waypointGroupDragDelta &&
      selectedWaypoints.has(waypointKey(id, index))
    ) {
      const origin = persistedWaypoints[index] ?? point;
      return { x: origin.x + waypointGroupDragDelta.dx, y: origin.y + waypointGroupDragDelta.dy };
    }
    return point;
  });
  // Path/geometry view: same substitution, plus the bare-label drag-to-
  // create preview point spliced in at its (fixed-for-the-drag) insertion
  // index so the rendered path bends live as the label is dragged, before
  // anything is actually committed to the doc — locally OR by a remote peer
  // (`remoteWaypointDrag?.mode === "insert"`, the broadcast equivalent of
  // `labelDragIndex`/`labelDragPoint`).
  const pathWaypoints =
    labelDragIndex !== null && labelDragPoint
      ? [
          ...renderedWaypoints.slice(0, labelDragIndex),
          labelDragPoint,
          ...renderedWaypoints.slice(labelDragIndex),
        ]
      : remoteWaypointDrag?.mode === "insert"
        ? [
            ...renderedWaypoints.slice(0, remoteWaypointDrag.waypointIndex),
            { x: remoteWaypointDrag.x, y: remoteWaypointDrag.y },
            ...renderedWaypoints.slice(remoteWaypointDrag.waypointIndex),
          ]
        : renderedWaypoints;

  const points = buildPolyline(source, pathWaypoints, target);
  const effectiveStyle = resolveConnectionStyle(record.style, settings.connectionStyle);
  const pathD = buildStyledPathD(points, effectiveStyle);
  // `pointAtT`'s arc-length walk still operates on the STRAIGHT polyline
  // regardless of rendering style. Only ever used for the bare (no
  // waypoint) label's position now — once a real waypoint exists it's
  // rendered at its own stored `x`/`y` instead, no arc-length math involved.
  const labelPoint = pointAtT(points, record.labelPos ?? DEFAULT_LABEL_POS);
  // While actively drag-creating the first waypoint — locally or by a
  // remote peer — the bare label should track the cursor exactly (it's the
  // thing being dragged) rather than its usual arc-length position.
  const displayLabelPoint =
    labelDragPoint ??
    (remoteWaypointDrag?.mode === "insert"
      ? { x: remoteWaypointDrag.x, y: remoteWaypointDrag.y }
      : labelPoint);

  // Every label on this edge — the bare one and every waypoint's — shows
  // the same content: the part's icon (like the reference Satisfactory
  // Modeler app) plus the bare rate number, or just the part name as text
  // when no rate at all is knowable yet (`resolveEdgeRate`'s null case —
  // pre-first-solve, or a genuinely disconnected part with nothing on
  // either end to read a rate from).
  const edgeResult = edgeResultById.get(id);
  const iconUrl = getIconUrl(record.part);
  const resolvedRate = resolveEdgeRate(record, edgeResultById, nodeResultById);
  const labelText = resolvedRate ? formatRate(resolvedRate, settings.numberFormats) : record.part;

  // Calculation-validation visuals: color the wire itself, not just the
  // nodes at either end — a user shouldn't have to trace a red/orange
  // border back to figure out WHICH connection caused it. `"unknown"` (no
  // `EdgeSolveResult` at all — None mode, pre-first-solve, or an edge
  // incident to a Splurger, whose rewrite genuinely has no per-edge result
  // to look up — see `splurgerPassthrough.ts`'s header) renders exactly as
  // before this pass: no color change, no regression.
  const edgeValidity = classifyEdgeValidity(edgeResult);
  const validityStroke = strokeColorFor(edgeValidity);
  // Reuses the exact same solver-authored explanation text
  // `computeMismatchDetails.ts`/`RecipeNode.tsx`'s card banner already show
  // (never re-derived here) — a mismatched wire's tooltip says WHY, not just
  // "something's wrong."
  const mismatchDetail =
    edgeValidity === "mismatched"
      ? computeMismatchDetails([{ edgeId: id, part: record.part }], edgeResultById)[record.part]
      : undefined;
  // `undefined` (valid/unknown) means "no validity story to tell" — each
  // label div below falls back to its own normal gesture-hint title in that
  // case, unchanged from before this pass.
  const validityTitle =
    edgeValidity === "invalid"
      ? t("node.portTooltip.invalid")
      : edgeValidity === "mismatched"
        ? t("node.portTooltip.mismatched", {
            detail: mismatchDetail ?? t("node.mismatchDetailFallback"),
          })
        : undefined;

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
    const point = settings.snapWaypoints
      ? snapPointToGrid(midpoint, settings.gridWaypoint)
      : midpoint;
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
    // This `stopPropagation()` means the wrapper's own cursor-publishing
    // `onPointerMove` never sees this event — see `throttledSetCursor`'s
    // own doc comment for why this call has to happen here instead.
    throttledSetCursor({ x: flowPos.x, y: flowPos.y, containerId });
    // `labelDragIndex` state (set below) isn't visible until the next
    // render — captured here too so the very first `publish` call of a
    // fresh drag (same event that just crossed the threshold) still carries
    // a real index instead of the stale pre-drag `null`.
    let indexForPublish = labelDragIndex;
    if (labelDragIndex === null) {
      const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      if (distance < LABEL_DRAG_THRESHOLD_PX) return;
      // Decided once, at the moment the drag starts, against the polyline
      // as it stood before this gesture touched it. In practice this is
      // always segment 0 (the bare label only exists while there are no
      // waypoints, i.e. exactly one segment), computed generically rather
      // than hardcoded.
      indexForPublish = nearestSegmentIndex(points, flowPos);
      setLabelDragIndex(indexForPublish);
    }
    setLabelDragPoint(flowPos);
    edgeDragPublisher.publish({
      mode: "insert",
      waypointIndex: indexForPublish!,
      x: flowPos.x,
      y: flowPos.y,
    });
  }

  function handleLabelPointerUp(event: ReactPointerEvent) {
    // Unconditional, same reasoning as `handleLabelPointerDown` — this must
    // run before the `press` guard below so even a right-button release
    // (which never set `press`) is still swallowed here.
    event.stopPropagation();
    const press = labelPressRef.current;
    if (!press) return;
    labelPressRef.current = null;
    edgeDragPublisher.clear();
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // See `handleWaypointPointerDown`'s identical try/catch — safe to ignore.
    }

    if (labelDragIndex !== null && labelDragPoint) {
      const settings = getSettings(sfmDoc);
      const point = settings.snapWaypoints
        ? snapPointToGrid(labelDragPoint, settings.gridWaypoint)
        : labelDragPoint;
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
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setDragPoint(flowPos);
    edgeDragPublisher.publish({
      mode: "move",
      waypointIndex: dragIndex,
      x: flowPos.x,
      y: flowPos.y,
    });
    // This `stopPropagation()` means the wrapper's own cursor-publishing
    // `onPointerMove` never sees this event — see `throttledSetCursor`'s
    // own doc comment for why this call has to happen here instead.
    throttledSetCursor({ x: flowPos.x, y: flowPos.y, containerId });

    // Dragging a waypoint that's part of a marquee selection carries the
    // WHOLE selection along — other selected waypoints (via
    // `waypointGroupDragDelta`, read by every `ConnectionEdge` including
    // this one) and any selected nodes (via `groupNodeMove.preview`, which
    // no-ops harmlessly if nothing's node-selected). `record.waypoints`
    // (not `storedWaypoints`) is this waypoint's PERSISTED, pre-drag
    // position — the correct origin for "how far has the group moved so
    // far", same reasoning as `CanvasView.tsx`'s own node-driven half of
    // this feature.
    const myKey = waypointKey(id, dragIndex);
    if (selectedWaypoints.has(myKey)) {
      const origin = persistedWaypoints[dragIndex];
      if (origin) {
        const dx = flowPos.x - origin.x;
        const dy = flowPos.y - origin.y;
        setWaypointGroupDragDelta({ dx, dy });
        groupNodeMove.preview(dx, dy);
      }
    }
  }

  function handleWaypointPointerUp(event: ReactPointerEvent) {
    // Unconditional, same reasoning as `handleLabelPointerUp` — must run
    // before the `dragIndex` guard so a right-button release (which never
    // set `dragIndex`, per the button check above) is still swallowed here
    // instead of reaching the marquee wrapper's own `onPointerUp`.
    event.stopPropagation();
    if (dragIndex === null) return;
    edgeDragPublisher.clear();
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
      const point = settings.snapWaypoints
        ? snapPointToGrid(flowPos, settings.gridWaypoint)
        : flowPos;
      // Read BEFORE `updateWaypoint` commits THIS waypoint's own new
      // position — this needs the PERSISTED (pre-drag) position to compute
      // the group's total delta, same origin `handleWaypointPointerMove`'s
      // own preview already used throughout the gesture.
      const myKey = waypointKey(id, dragIndex);
      const isGroupDrag = selectedWaypoints.has(myKey);
      const origin = isGroupDrag ? persistedWaypoints[dragIndex] : undefined;
      updateWaypoint(sfmDoc, id, dragIndex, point);
      if (isGroupDrag && origin) {
        const dx = point.x - origin.x;
        const dy = point.y - origin.y;
        if (dx !== 0 || dy !== 0) {
          for (const key of selectedWaypoints) {
            if (key === myKey) continue;
            const parsed = parseWaypointKey(key);
            if (!parsed) continue;
            const edgeRecord = getEdge(sfmDoc, parsed.edgeId);
            const otherWaypoint = edgeRecord?.waypoints[parsed.index];
            if (!otherWaypoint) continue;
            updateWaypoint(sfmDoc, parsed.edgeId, parsed.index, {
              x: otherWaypoint.x + dx,
              y: otherWaypoint.y + dy,
            });
          }
        }
        groupNodeMove.commit();
        setWaypointGroupDragDelta(null);
      }
    }
    setDragIndex(null);
    setDragPoint(null);
  }

  // Live drag broadcasting: a colored outline (matching the dragger's own
  // presence color) on whichever label a REMOTE peer currently has in
  // flight — the connection/waypoint equivalent of the outline
  // `CanvasView.tsx` already draws around a remotely-dragged node. Never
  // shown while THIS client has its own competing local drag in progress on
  // the same edge (the `labelDragIndex`/`dragIndex === null` guards below).
  const remoteLabelOutlineStyle =
    remoteWaypointDrag?.mode === "insert" && labelDragIndex === null
      ? { outline: `2px solid ${remoteWaypointDrag.color}`, outlineOffset: 2 }
      : {};
  function remoteWaypointOutlineStyle(index: number) {
    if (remoteWaypointDrag?.mode === "move" && remoteWaypointDrag.waypointIndex === index && dragIndex === null) {
      return { outline: `2px solid ${remoteWaypointDrag.color}`, outlineOffset: 2 };
    }
    const remoteGroupPosition = dragIndex === null ? remoteGroupWaypoints?.get(index) : undefined;
    if (remoteGroupPosition) {
      return { outline: `2px solid ${remoteGroupPosition.color}`, outlineOffset: 2 };
    }
    return {};
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={pathD}
        markerEnd={markerEnd}
        style={{
          // Validity wins over the plain "selected" look — same precedence
          // `RecipeNode.tsx`'s own border cascade already established
          // (`highlightBorderClass(...) ?? ... ?? (selected ? accent : ...)`):
          // a broken/mismatched wire needs to stay visible even while
          // selected, not get masked by the accent color.
          stroke: validityStroke ?? (selected ? "var(--accent)" : "var(--text-muted)"),
          strokeWidth: validityStroke ? 2.5 : selected ? 2 : 1.5,
          ...style,
        }}
        interactionWidth={16}
      />
      <EdgeLabelRenderer>
        {storedWaypoints.length === 0 && (
          <div
            className={`${labelClass} ${!validityStroke && selected ? "border-[var(--accent)] text-[var(--accent)]" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${displayLabelPoint.x}px, ${displayLabelPoint.y}px)`,
              pointerEvents: "all",
              zIndex: EDGE_OVERLAY_Z_INDEX,
              ...(readOnly ? { cursor: "default" } : {}),
              ...(validityStroke ? { borderColor: validityStroke, color: validityStroke } : {}),
              ...remoteLabelOutlineStyle,
            }}
            onPointerDown={readOnly ? undefined : handleLabelPointerDown}
            onPointerMove={readOnly ? undefined : handleLabelPointerMove}
            onPointerUp={readOnly ? undefined : handleLabelPointerUp}
            onContextMenu={readOnly ? undefined : handleLabelContextMenu}
            title={
              readOnly
                ? validityTitle
                : (validityTitle ?? "Drag to create a waypoint. Double-right-click: delete connection.")
            }
          >
            {iconUrl && <img src={iconUrl} alt="" className={labelIconClass} draggable={false} />}
            {labelText}
          </div>
        )}
        {renderedWaypoints.map((point, index) => (
          <div
            // Waypoint identity *is* its array index (that's what
            // `addWaypoint`/`removeWaypoint`/`updateWaypoint` address by) —
            // there's no other stable id to key on.
            key={index}
            // Marquee-selected (independent of `selected`, the whole
            // edge's own React Flow selection flag) gets the identical
            // accent-border treatment — a waypoint has no other visual
            // "this is part of the current selection" signal of its own.
            className={`${labelClass} ${!validityStroke && (selected || selectedWaypoints.has(waypointKey(id, index))) ? "border-[var(--accent)] text-[var(--accent)]" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)`,
              pointerEvents: "all",
              zIndex: EDGE_OVERLAY_Z_INDEX + 1,
              ...(readOnly ? { cursor: "default" } : {}),
              ...(validityStroke ? { borderColor: validityStroke, color: validityStroke } : {}),
              ...remoteWaypointOutlineStyle(index),
            }}
            onClick={readOnly ? undefined : (event) => handleWaypointClick(index, event)}
            onContextMenu={readOnly ? undefined : (event) => handleWaypointContextMenu(index, event)}
            onPointerDown={readOnly ? undefined : (event) => handleWaypointPointerDown(index, event)}
            onPointerMove={readOnly ? undefined : handleWaypointPointerMove}
            onPointerUp={readOnly ? undefined : handleWaypointPointerUp}
            title={
              readOnly
                ? validityTitle
                : (validityTitle ??
                  "Drag to move. Double-click: insert a waypoint after this one. Double-right-click: remove this waypoint.")
            }
          >
            {iconUrl && <img src={iconUrl} alt="" className={labelIconClass} draggable={false} />}
            {labelText}
          </div>
        ))}
      </EdgeLabelRenderer>
    </>
  );
});
