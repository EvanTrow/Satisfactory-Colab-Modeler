// Job 013: projects the whole document's edges onto a single container
// view. Builds on `portMapping.ts`'s `resolveNodeLocation` (the same
// ancestry-walk primitive `computeOutpostPorts` uses) to decide, per edge,
// whether it renders directly (both endpoints are real nodes in the current
// view), as a boundary connection (one endpoint is inside a child outpost,
// so the edge should visually terminate at that outpost's own boundary
// node instead of reaching into it), between two sibling outposts, or not
// at all (it belongs to a different view entirely — e.g. fully nested
// inside one child outpost, which will show it when *that* container is
// viewed).
//
// Pure function of already-loaded doc state, same discipline as
// `portMapping.ts` — no Yjs access, fully unit-testable. `useYjsSync.ts` is
// the only caller, once per resync.
import type { EdgeRecord, NodeRecord } from "@scm/ydoc";

import { type ContainerParentMap, boundaryPortId, resolveNodeLocation } from "./portMapping";

export interface ProjectedEdge {
  /** The real, underlying `EdgeRecord` — ground truth (endpoints, waypoints, part, labelPos) is untouched; only the *rendered* source/target below are projected. */
  record: EdgeRecord;
  /** True when either endpoint of this edge had to be redirected to a container's boundary node — i.e. this is a derived/synthetic projection, not the edge's own literal endpoints. Callers use this to pick a non-interactive rendering (no waypoint dragging — the stored waypoints live in a different container's coordinate space and aren't meaningful here). */
  projected: boolean;
  /** Node id (real) or container id (boundary) to render this edge's source at. */
  source: string;
  sourceHandle: string;
  /** Node id (real) or container id (boundary) to render this edge's target at. */
  target: string;
  targetHandle: string;
}

/**
 * For view `viewContainerId`, classifies every edge in the whole document
 * and returns only the ones visible from this view, each with its rendered
 * source/target already resolved to either a real node id or a child
 * container's boundary-node id.
 *
 * The handle ids used for a boundary endpoint (`boundaryPortId(edge.id,
 * direction)`) are the *exact* ids `portMapping.ts`'s `computeOutpostPorts`
 * assigns that same edge when computing the corresponding outpost's own
 * port list — the two aren't independently derived, so a boundary node's
 * rendered `<Handle>` elements and this function's synthetic edge
 * endpoints can never disagree on an id.
 */
export function computeVisibleEdges(
  viewContainerId: string,
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
  parentOf: ContainerParentMap,
): ProjectedEdge[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const visible: ProjectedEdge[] = [];

  for (const edge of edges) {
    const fromNode = nodesById.get(edge.fromNode);
    const toNode = nodesById.get(edge.toNode);
    if (!fromNode || !toNode) continue; // dangling reference — not this module's job to repair (Job 022).

    const fromLoc = resolveNodeLocation(fromNode.containerId, viewContainerId, parentOf);
    const toLoc = resolveNodeLocation(toNode.containerId, viewContainerId, parentOf);
    if (fromLoc === null || toLoc === null) continue; // not part of this view at all.

    // Both endpoints resolve into the *same* child outpost's subtree —
    // this edge is purely internal to that outpost, not this view; it'll
    // render when that outpost is the current view instead.
    if (fromLoc.kind === "boundary" && toLoc.kind === "boundary" && fromLoc.containerId === toLoc.containerId) {
      continue;
    }

    const source = fromLoc.kind === "direct" ? fromNode.id : fromLoc.containerId;
    const sourceHandle = fromLoc.kind === "direct" ? edge.fromPort : boundaryPortId(edge.id, "out");
    const target = toLoc.kind === "direct" ? toNode.id : toLoc.containerId;
    const targetHandle = toLoc.kind === "direct" ? edge.toPort : boundaryPortId(edge.id, "in");

    visible.push({
      record: edge,
      projected: fromLoc.kind === "boundary" || toLoc.kind === "boundary",
      source,
      sourceHandle,
      target,
      targetHandle,
    });
  }

  return visible;
}
