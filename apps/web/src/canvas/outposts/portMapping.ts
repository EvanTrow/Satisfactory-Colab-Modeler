// Job 013: derived port mapping for outposts (PLAN.md §2's "Outposts" row —
// "from outside, the outpost is a single node with input/output ports" —
// and §3's "port mapping on the outpost node at the parent level").
//
// **The port set is never stored.** It's a pure function of the doc's
// current `nodes`/`edges`/`containers`, recomputed on every render from
// whatever's currently loaded — exactly PLAN.md §4's "no solver output
// lives in the CRDT" principle, generalized to this derived value too (see
// this job's own Notes-for-the-worker: "keep port mapping derived/computed,
// not stored ... to avoid drift"). Nothing in this file touches a
// `SfmDocument`/`Y.Doc` — it's plain-object-in, plain-object-out, so it's
// unit-testable the same way `edges/connectionLogic.ts` (Job 011) and
// `selection/clipboard.ts` (Job 012) are: real `@scm/ydoc` fixtures, no
// React, no Yjs observers.
//
// --- The boundary-crossing-edge design decision (Job 007 left this open) ---
//
// `EdgeRecord.containerId` records which container's *canvas view* an edge
// was drawn in — it's set once, at creation time, to whatever container was
// the active view (see `edges/connectionLogic.ts`'s `connectPorts`). It is
// **not** treated as authoritative for "is this edge a boundary crossing"
// here, and deliberately so: the realistic way a boundary-crossing edge
// comes into being isn't "the user dragged a wire across two different
// open canvases at once" (impossible — only one container's contents are
// ever rendered at a time, per this job's other core change), it's "the
// user wired two nodes together while both were in the same container,
// then moved one of them into (or out of) an outpost via
// `outposts/reparent.ts`'s `moveNodeToContainer`." After that move, the
// edge's `fromNode`/`toNode` still resolve directly (edges reference node
// ids, never container-qualified — Job 007's schema doesn't have a
// "boundary crossing" concept, so nothing on the edge record itself needs
// to change), but the two endpoints' nodes now live in different
// containers. So: **whether an edge crosses a boundary, and which boundary,
// is derived entirely from the current `containerId` of its `fromNode` and
// `toNode`, walked up each node's container-ancestry chain** — never from
// `edge.containerId`. This is what makes it correct without drift no matter
// how a node got moved (a plain "move into outpost" action, or — later —
// any other mechanism that changes `NodeRecord.containerId`).
import type { Container, EdgeRecord, NodeRecord } from "@scm/ydoc";

/** `containerId -> parentId` lookup, built once per render from `listContainers`. */
export type ContainerParentMap = ReadonlyMap<string, string | null>;

export function buildContainerParentMap(containers: readonly Container[]): ContainerParentMap {
  const map = new Map<string, string | null>();
  for (const container of containers) {
    map.set(container.id, container.parentId);
  }
  return map;
}

/**
 * Where a node (identified by its own `containerId`) renders relative to a
 * given view (`viewContainerId`):
 *   - `"direct"` — the node lives directly in the view; render it as a real node.
 *   - `{ kind: "boundary", containerId }` — the node lives inside a
 *     descendant of `containerId`, an *immediate* child container of the
 *     view — render whatever references this node as terminating at that
 *     child's boundary node instead.
 *   - `null` — the node isn't inside the view's subtree at all (e.g. it's
 *     an ancestor, or a cousin branch) — invisible from this view.
 */
export type NodeLocation = { kind: "direct" } | { kind: "boundary"; containerId: string } | null;

export function resolveNodeLocation(
  nodeContainerId: string,
  viewContainerId: string,
  parentOf: ContainerParentMap,
): NodeLocation {
  if (nodeContainerId === viewContainerId) return { kind: "direct" };
  let current: string | null = nodeContainerId;
  while (current !== null) {
    // Named `parentId`, not `parent` — shadowing the DOM lib's global
    // `parent: Window` here confused TypeScript's control-flow inference
    // across this loop's reassignment (`TS7022`, a circular-initializer
    // false positive) even though nothing here is actually recursive.
    const parentId: string | null = parentOf.get(current) ?? null;
    if (parentId === viewContainerId) return { kind: "boundary", containerId: current };
    current = parentId;
  }
  return null;
}

/** True if `containerId` is `ancestorId` itself, or nested (at any depth) inside it. */
export function isContainerWithinSubtree(
  containerId: string,
  ancestorId: string,
  parentOf: ContainerParentMap,
): boolean {
  let current: string | null = containerId;
  while (current !== null) {
    if (current === ancestorId) return true;
    current = parentOf.get(current) ?? null;
  }
  return false;
}

/**
 * Stable id scheme for a derived boundary handle: `boundary:<edgeId>:<direction>`.
 * One port per crossing *edge* (not one per part-name) — the simplest,
 * least-ambiguous reading of "the port set is derived from which parts
 * cross the outpost's boundary" that composes correctly when two sibling
 * outposts are connected to each other (see `computeOutpostPorts`'s doc
 * comment) and needs no extra aggregation step. Exported so
 * `outposts/visibleGraph.ts` can produce the exact same handle id when
 * projecting a boundary-crossing edge's rendered `sourceHandle`/
 * `targetHandle` at the parent view — the two are two views of one
 * `computeOutpostPorts` result, not independently-derived, so they can
 * never disagree on an id.
 */
export function boundaryPortId(edgeId: string, direction: "in" | "out"): string {
  return `boundary:${edgeId}:${direction}`;
}

export interface DerivedOutpostPort {
  /** Stable handle id — see `boundaryPortId`. */
  id: string;
  /** From the outpost's own perspective: "out" = a part leaving the outpost, "in" = a part entering it. */
  direction: "in" | "out";
  part: string;
  /** The real `EdgeRecord` id this port is derived from. */
  edgeId: string;
  /** The node id on the far side of the boundary (may itself be nested inside a sibling outpost — `outposts/visibleGraph.ts` resolves that further for rendering). */
  remoteNodeId: string;
}

/**
 * Computes outpost `outpostContainerId`'s derived port list: one port per
 * edge with **exactly one** endpoint inside the outpost's own subtree (the
 * outpost itself, or any container nested inside it) and the other endpoint
 * outside it. An edge with both endpoints inside (purely internal) or both
 * endpoints outside (irrelevant to this outpost) contributes no port.
 *
 * Pure function of already-loaded doc state (`nodes`/`edges`/the
 * container-ancestry map) — nothing here reads or writes the Yjs doc, and
 * the result is never written back onto the `Container` record itself (see
 * this module's header comment). Callers should recompute this on every
 * render from the live `listNodes`/`listEdges`/`listContainers` snapshot,
 * exactly like `apps/web`'s other derived-per-render values.
 */
export function computeOutpostPorts(
  outpostContainerId: string,
  nodes: readonly NodeRecord[],
  edges: readonly EdgeRecord[],
  parentOf: ContainerParentMap,
): DerivedOutpostPort[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const ports: DerivedOutpostPort[] = [];

  for (const edge of edges) {
    const fromNode = nodesById.get(edge.fromNode);
    const toNode = nodesById.get(edge.toNode);
    if (!fromNode || !toNode) continue; // dangling reference (e.g. a concurrent-delete race) — not this module's job to repair, see Job 022.

    const fromInside = isContainerWithinSubtree(fromNode.containerId, outpostContainerId, parentOf);
    const toInside = isContainerWithinSubtree(toNode.containerId, outpostContainerId, parentOf);
    if (fromInside === toInside) continue; // both inside (internal) or both outside (unrelated) — no port either way.

    if (fromInside) {
      ports.push({
        id: boundaryPortId(edge.id, "out"),
        direction: "out",
        part: edge.part,
        edgeId: edge.id,
        remoteNodeId: edge.toNode,
      });
    } else {
      ports.push({
        id: boundaryPortId(edge.id, "in"),
        direction: "in",
        part: edge.part,
        edgeId: edge.id,
        remoteNodeId: edge.fromNode,
      });
    }
  }

  return ports;
}
