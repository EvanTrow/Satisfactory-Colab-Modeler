// Right-click-drag marquee multi-select (Job 012 — PLAN.md §2's "Select"
// row: "right-click-drag a marquee for multi-select", called out
// specifically as right-click because left-click-drag is reserved for
// panning).
//
// Why this is hand-rolled instead of `@xyflow/react`'s own
// `selectionOnDrag`/`selectionKeyCode` props: React Flow's built-in
// marquee-start gate (`Pane`'s `onPointerDownCapture`, in
// `@xyflow/react`'s `dist/esm/index.mjs`) hardcodes
// `event.button !== 0` as an early bail — it only ever starts a marquee for
// the *left* mouse button, with no prop to change that. Separately (and
// conveniently), the pan/zoom filter (`@xyflow/system`'s `createFilter`)
// already rejects the right mouse button for panning whenever `panOnDrag`
// is left at its default `true` (its own `buttonAllowed` check is
// `!event.button || event.button <= 1`, i.e. button 0 or 1 only) — so a
// right-button drag on the canvas background does *nothing* in stock React
// Flow, leaving it free for this hook to own outright with no prop tuning
// needed on `<ReactFlow>` itself.
//
// This hook is pointer-event-only (no dependency on React Flow's own
// selection machinery) and applies the result through the same
// `onNodesChange`/`onEdgesChange` callbacks a normal click-select uses
// (`{ type: "select", selected }` changes — see `@xyflow/system`'s
// `NodeSelectionChange`/`EdgeSelectionChange`), so a marquee selection is
// indistinguishable, from every other consumer's point of view (React
// Flow's own rendering, `useSelectionKeybinds.ts`'s cut/copy/delete), from
// a normal click selection.
import { useRef, useState } from "react";

import type { EdgeChange, NodeChange } from "@xyflow/react";

import type { CanvasEdge, CanvasNode, UseYjsSyncResult } from "../useYjsSync";
import { type Point, type Rect, polylineIntersectsRect, rectFromPoints, rectsIntersect } from "./marqueeGeometry";

/** How far (in screen px) the pointer has to move past the right-button-down point before this counts as a drag (a marquee) rather than a quick right-click (which should fall through to `onPaneContextMenu`'s Recipe Chooser, per Job 009). Matches `doubleClick.ts`'s general click-vs-drag tolerance philosophy, kept smaller here since a marquee's own visual feedback (the overlay rect) makes an over-eager "is this a drag yet" call much less confusing than a mistimed double-click would be. */
const MARQUEE_DRAG_THRESHOLD_PX = 4;

/** Fallback node footprint for a node whose `measured` size isn't available yet (a node that hasn't completed its first paint) — matches `RecipeNode.tsx`'s fixed `w-64` (256px) card width; height is a rough average since `RecipeNode`'s height varies with part-row count. Only ever used for that brief unmeasured window, so exactness doesn't matter much. */
const FALLBACK_NODE_WIDTH = 256;
const FALLBACK_NODE_HEIGHT = 160;

export interface MarqueeOverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface UseMarqueeSelectionOptions {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onNodesChange: UseYjsSyncResult["onNodesChange"];
  onEdgesChange: UseYjsSyncResult["onEdgesChange"];
  /** Converts a screen/client point into flow/document coordinates — pass `useReactFlow().screenToFlowPosition` straight through. */
  screenToFlowPosition: (point: Point) => Point;
  /** False while e.g. the Recipe Chooser modal is open, so a right-drag over it doesn't start a marquee underneath. */
  enabled: boolean;
}

export interface UseMarqueeSelectionResult {
  /** Screen-space rect (CSS `left`/`top`/`width`/`height`) to render the marquee overlay at, or `null` when no drag is in progress. */
  overlayRect: MarqueeOverlayRect | null;
  /** Spread onto the element wrapping `<ReactFlow>` (needs to cover the whole canvas, not just the pane, so a marquee can start over a node too). */
  pointerHandlers: {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
    onPointerCancel: (event: React.PointerEvent) => void;
  };
  /**
   * Returns whether the *most recent* right-button press ended in an actual
   * marquee drag, and resets that flag. `CanvasView.tsx`'s
   * `handlePaneContextMenu` calls this first and, if it returns `true`,
   * skips opening the Recipe Chooser — the browser's native `contextmenu`
   * event still fires after a right-drag release on most platforms (it's
   * not reliably suppressed by drag distance the way some apps assume), so
   * this is what keeps "right-click-drag a marquee" from also popping the
   * chooser Job 009 wired up for a plain right-click.
   */
  consumeJustDragged: () => boolean;
}

interface DragState {
  start: Point;
  dragging: boolean;
}

function nodeCenter(node: CanvasNode): Point {
  const width = node.measured?.width ?? FALLBACK_NODE_WIDTH;
  const height = node.measured?.height ?? FALLBACK_NODE_HEIGHT;
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 };
}

function nodeRect(node: CanvasNode): Rect {
  const width = node.measured?.width ?? FALLBACK_NODE_WIDTH;
  const height = node.measured?.height ?? FALLBACK_NODE_HEIGHT;
  return { x: node.position.x, y: node.position.y, width, height };
}

export function useMarqueeSelection(options: UseMarqueeSelectionOptions): UseMarqueeSelectionResult {
  const { nodes, edges, onNodesChange, onEdgesChange, screenToFlowPosition, enabled } = options;

  const dragStateRef = useRef<DragState | null>(null);
  const justDraggedRef = useRef(false);
  const [overlayRect, setOverlayRect] = useState<MarqueeOverlayRect | null>(null);

  function applySelection(startScreen: Point, endScreen: Point) {
    const flowRect = rectFromPoints(screenToFlowPosition(startScreen), screenToFlowPosition(endScreen));

    const centers = new Map<string, Point>();
    const hitNodeIds = new Set<string>();
    for (const node of nodes) {
      centers.set(node.id, nodeCenter(node));
      if (rectsIntersect(flowRect, nodeRect(node))) hitNodeIds.add(node.id);
    }

    const hitEdgeIds = new Set<string>();
    for (const edge of edges) {
      const sourceCenter = centers.get(edge.source);
      const targetCenter = centers.get(edge.target);
      if (!sourceCenter || !targetCenter) continue; // endpoint node not in this container's current node list — shouldn't happen, defensive only
      // An edge between two marquee-hit nodes counts as "under the marquee"
      // even if its particular path (e.g. a short edge between two large,
      // barely-overlapping nodes) happens not to cross the rect itself —
      // this mirrors `clipboard.ts`'s "internal edge" convention and is
      // what makes "marquee two connected nodes, then copy" behave as
      // expected without a separate special case.
      if (hitNodeIds.has(edge.source) && hitNodeIds.has(edge.target)) {
        hitEdgeIds.add(edge.id);
        continue;
      }
      const waypoints = edge.data?.record.waypoints ?? [];
      const polyline: Point[] = [sourceCenter, ...waypoints, targetCenter];
      if (polylineIntersectsRect(polyline, flowRect)) hitEdgeIds.add(edge.id);
    }

    const nodeChanges: NodeChange<CanvasNode>[] = nodes.map((node) => ({
      id: node.id,
      type: "select",
      selected: hitNodeIds.has(node.id),
    }));
    const edgeChanges: EdgeChange<CanvasEdge>[] = edges.map((edge) => ({
      id: edge.id,
      type: "select",
      selected: hitEdgeIds.has(edge.id),
    }));
    onNodesChange(nodeChanges);
    onEdgesChange(edgeChanges);
  }

  function onPointerDown(event: React.PointerEvent) {
    justDraggedRef.current = false; // a fresh right-button gesture always starts clean, in case a previous drag's `contextmenu` never fired to consume the flag itself (see `consumeJustDragged`'s doc comment)
    if (!enabled || event.button !== 2) return;
    dragStateRef.current = { start: { x: event.clientX, y: event.clientY }, dragging: false };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Same defensive swallow `ConnectionEdge.tsx` (Job 011) uses around
      // `setPointerCapture` — some browsers/test harnesses throw
      // `NotFoundError` here; it's not fatal to the gesture either way.
    }
  }

  function onPointerMove(event: React.PointerEvent) {
    const state = dragStateRef.current;
    if (!state) return;
    const current = { x: event.clientX, y: event.clientY };
    if (!state.dragging) {
      const distance = Math.hypot(current.x - state.start.x, current.y - state.start.y);
      if (distance < MARQUEE_DRAG_THRESHOLD_PX) return;
      state.dragging = true;
    }
    setOverlayRect(toOverlayRect(rectFromPoints(state.start, current)));
  }

  function onPointerUp(event: React.PointerEvent) {
    const state = dragStateRef.current;
    dragStateRef.current = null;
    if (!state) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // See `onPointerDown`'s comment.
    }
    if (state.dragging) {
      justDraggedRef.current = true;
      applySelection(state.start, { x: event.clientX, y: event.clientY });
    }
    setOverlayRect(null);
  }

  function onPointerCancel() {
    dragStateRef.current = null;
    setOverlayRect(null);
  }

  function consumeJustDragged(): boolean {
    const value = justDraggedRef.current;
    justDraggedRef.current = false;
    return value;
  }

  return {
    overlayRect,
    pointerHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    consumeJustDragged,
  };
}

function toOverlayRect(rect: Rect): MarqueeOverlayRect {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}
