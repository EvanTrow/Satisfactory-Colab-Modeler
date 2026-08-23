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

import { isOutpostIoKind } from "./io";
import { type ContainerParentMap, outpostBoundaryHandleId, resolveNodeLocation } from "./portMapping";

/**
 * Outpost I/O rework: the handle id an endpoint should render
 * with — `outpostBoundaryHandleId`'s real `${direction}:${part}` scheme
 * whenever the endpoint IS one of the two locked pass-through nodes,
 * REGARDLESS of whether this particular edge happens to be "direct" (both
 * endpoints in the current view) or "boundary" (redirected to a child
 * container's own boundary node).
 *
 * This distinction matters because a wire touching an Inputs/Outputs node
 * can be "direct" too — e.g. the purely-internal edge from an internal
 * recipe to the Outputs node, viewed from INSIDE the outpost, has BOTH
 * endpoints in-view. For a "direct" edge between two ORDINARY nodes, the
 * existing `edge.fromPort`/`.toPort` is already the right, stable handle id
 * (a real recipe's own `${dir}:${part}` scheme, assigned once and never
 * ambiguous). But for a "direct" edge whose endpoint IS the locked node, the
 * STORED port string can permanently be the wildcard sentinel (`in:*`/
 * `out:*`) from whichever "+" row it was originally dragged onto — per the
 * "wildcards never get renamed after connecting" convention
 * `StorageNode.tsx`/`SplurgerNode.tsx` already established — while the
 * node's own RENDERED row for that part uses the real, freshly-computed
 * `${dir}:${part}` id (`OutpostIoNode.tsx`, so a second same-part connection
 * can land on the same named row instead of piling up on the wildcard one).
 * Using the raw stored port for a "direct" edge here would target the
 * WILDCARD handle instead of the correct named row's handle — confirmed
 * live as "the connection lands on the wrong dot" once a part graduated
 * from the wildcard row to its own named one.
 */
function endpointHandleId(node: NodeRecord, edge: EdgeRecord, direction: "in" | "out", isDirect: boolean, rawPort: string): string {
  if (isDirect && !isOutpostIoKind(node.kind)) return rawPort;
  return outpostBoundaryHandleId(node, edge, direction);
}

export interface ProjectedEdge {
  /** The real, underlying `EdgeRecord` — ground truth (endpoints, waypoints, part, labelPos) is untouched; only the *rendered* source/target below are projected. */
  record: EdgeRecord;
  /** True when either endpoint of this edge had to be redirected to a container's boundary node — i.e. this is a derived/synthetic projection, not the edge's own literal endpoints. `ConnectionEdge.tsx` reads this purely for its boundary-crossing visual treatment (dashed amber stroke, tooltip wording) — every edge, projected or not, only ever renders in the single view where both endpoints resolve together, so the stored waypoints stay meaningful in that view's coordinate space either way, and every gesture (drag/add/remove a waypoint, delete the connection) works the same. */
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
    const sourceHandle = endpointHandleId(fromNode, edge, "out", fromLoc.kind === "direct", edge.fromPort);
    const target = toLoc.kind === "direct" ? toNode.id : toLoc.containerId;
    const targetHandle = endpointHandleId(toNode, edge, "in", toLoc.kind === "direct", edge.toPort);

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
