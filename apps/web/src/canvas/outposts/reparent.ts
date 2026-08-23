// Job 013: "moving a node into/out of an outpost updates its containerId"
// and "deleting an outpost reparents its children rather than destroying
// them" (PLAN.md §5's integrity-reducer principle — "reparent orphaned
// nodes to the root container rather than deleting them" — applied locally
// here for a single user's own actions; the full cross-client reducer is
// Job 022's scope, not this one's).
//
// Both operations go through `@scm/ydoc`'s mutation helpers only (never a
// hand-built `Y.Map` access) and each runs inside one `sfmDoc.doc.transact()`
// call, matching the pattern `selection/clipboard.ts`'s `deleteSelection`/
// `pasteClipboard` established in Job 012 — "delete/reparent N things" is
// one undo step, not N.
import {
  type Container,
  type SfmDocument,
  addEdge,
  getContainer,
  getNode,
  listContainers,
  listEdges,
  listEdgesByContainer,
  listNodes,
  listNodesByContainer,
  removeContainer,
  removeEdge,
  removeNode,
  reparentEdge,
  updateContainer,
  updateNode,
} from "@scm/ydoc";

import { computeSplurgerPassthroughEdges } from "../../workers/splurgerPassthrough";
import { buildContainerParentMap, isContainerWithinSubtree } from "./portMapping";
import { outpostInputNodeId, outpostOutputNodeId } from "./io";

/** Thin, transacted wrapper over `updateNode` for the "move a node into/out of an outpost" gesture — kept as its own named function (rather than callers reaching for `updateNode` directly) so this file is the one place both halves of "moving a node into/out of an outpost updates its containerId" (PLAN.md §3) live, alongside `deleteOutpost` below. */
export function moveNodeToContainer(sfmDoc: SfmDocument, nodeId: string, containerId: string): void {
  updateNode(sfmDoc, nodeId, { containerId });
}

export interface DeleteOutpostResult {
  /** Ids of nodes that were reparented (not destroyed) to the outpost's former parent. */
  reparentedNodeIds: string[];
  /** Ids of edges whose `containerId` was reparented alongside them. */
  reparentedEdgeIds: string[];
  /** Ids of any nested child containers (outposts inside the deleted one) that were reparented up rather than orphaned. */
  reparentedContainerIds: string[];
}

/**
 * Collapses one of an outpost's own locked `outpost-input`/`outpost-output`
 * pass-through nodes (`outposts/io.ts`) out of existence as part of
 * `deleteOutpost` — these two nodes have no meaning outside their own
 * container (they only exist to give the outer boundary card somewhere real
 * to land a dragged connection), so "keep contents" must not simply
 * reparent them like an ordinary node: `LOCKED_NODE_KINDS` (`io.ts`) blocks
 * their deletion through every normal UI path, which would otherwise leave
 * them stranded forever in the parent container once they're no longer
 * inside an outpost.
 *
 * Reuses `workers/splurgerPassthrough.ts`'s generic "erase a pass-through
 * node, wire whichever real node fed its one-sided port directly to every
 * real node on its many-sided port" rewrite — the exact same shape an
 * outpost's Inputs/Outputs node has (see that module's header) — but,
 * unlike its solver-only use elsewhere, actually materializes the result as
 * real `EdgeRecord`s so the connection survives the outpost's own removal
 * instead of merely being simulated at solve time. A part-group with no
 * correct rewrite (many-to-many on both sides) has no synthetic edge
 * produced for it, same as the solver path — that connection is lost along
 * with the node, the same way it would already be un-solvable while the
 * outpost still existed.
 */
function collapseIoNode(sfmDoc: SfmDocument, ioNodeId: string, parentId: string): void {
  const node = getNode(sfmDoc, ioNodeId);
  if (!node) return;
  const incident = listEdges(sfmDoc).filter((edge) => edge.fromNode === ioNodeId || edge.toNode === ioNodeId);
  const { edges: synthetic } = computeSplurgerPassthroughEdges([node], incident);
  for (const edge of synthetic) {
    addEdge(sfmDoc, {
      containerId: parentId,
      part: edge.part,
      fromNode: edge.fromNode,
      fromPort: edge.fromPort,
      toNode: edge.toNode,
      toPort: edge.toPort,
      style: null,
      labelPos: null,
    });
  }
  for (const edge of incident) removeEdge(sfmDoc, edge.id);
  removeNode(sfmDoc, ioNodeId);
}

/**
 * Deletes outpost `outpostId`, reparenting everything that lived directly
 * inside it — nodes, edges, and any nested child containers — to the
 * outpost's own parent, then removes the (now-empty) container itself.
 *
 * Per PLAN.md §5's integrity-reducer principle, applied locally: nothing
 * inside the outpost is destroyed. The former children simply reappear as
 * direct contents of the parent container the next time it's viewed —
 * exactly as if they'd never been grouped into the outpost, which is also
 * what makes any boundary-crossing edges the outpost used to show a
 * derived port for collapse back into ordinary internal edges
 * automatically (see `portMapping.ts`'s header comment): once both
 * endpoints share the reparented `containerId` again, `computeOutpostPorts`
 * simply stops finding a crossing. The outpost's own locked Inputs/Outputs
 * nodes are the one exception — they're collapsed away by `collapseIoNode`
 * instead of reparented, since they have no meaning (and no way to ever be
 * deleted again) outside their own container.
 *
 * Reparented positions are shifted so the former contents land where the
 * outpost's own boundary card sat in the parent view, not at their raw
 * (outpost-local) coordinates — otherwise they'd frequently land stacked on
 * top of whatever already exists near the parent's local origin.
 *
 * Throws if `outpostId` doesn't exist, or is the root container (which has
 * no parent to reparent into — deleting the root isn't a supported
 * operation, by construction: nothing in this app's UI offers it).
 */
export function deleteOutpost(sfmDoc: SfmDocument, outpostId: string): DeleteOutpostResult {
  const outpost = getContainer(sfmDoc, outpostId);
  if (!outpost) {
    throw new Error(`deleteOutpost: no container with id "${outpostId}"`);
  }
  if (outpost.parentId === null) {
    throw new Error("deleteOutpost: cannot delete the root container (it has no parent to reparent its contents into)");
  }
  const parentId = outpost.parentId;
  const inputId = outpostInputNodeId(outpostId);
  const outputId = outpostOutputNodeId(outpostId);

  const reparentedNodeIds: string[] = [];
  const reparentedEdgeIds: string[] = [];
  const reparentedContainerIds: string[] = [];

  sfmDoc.doc.transact(() => {
    const movableNodes = listNodesByContainer(sfmDoc, outpostId).filter(
      (node) => node.id !== inputId && node.id !== outputId,
    );
    const nestedChildren: Container[] = listContainers(sfmDoc).filter((c) => c.parentId === outpostId);

    // Anchor the reparented cluster's top-left corner at the outpost's own
    // former position in the parent view, rather than leaving it at
    // outpost-local coordinates that likely overlap unrelated parent content.
    let minX = Infinity;
    let minY = Infinity;
    for (const node of movableNodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
    }
    for (const child of nestedChildren) {
      minX = Math.min(minX, child.x);
      minY = Math.min(minY, child.y);
    }
    const hasContent = movableNodes.length > 0 || nestedChildren.length > 0;
    const dx = hasContent ? outpost.x - minX : 0;
    const dy = hasContent ? outpost.y - minY : 0;

    for (const node of movableNodes) {
      updateNode(sfmDoc, node.id, { containerId: parentId, x: node.x + dx, y: node.y + dy });
      reparentedNodeIds.push(node.id);
    }
    for (const edge of listEdgesByContainer(sfmDoc, outpostId)) {
      if (edge.fromNode === inputId || edge.toNode === inputId || edge.fromNode === outputId || edge.toNode === outputId) {
        continue;
      }
      reparentEdge(sfmDoc, edge.id, parentId);
      reparentedEdgeIds.push(edge.id);
    }
    for (const child of nestedChildren) {
      updateContainer(sfmDoc, child.id, { parentId, x: child.x + dx, y: child.y + dy });
      reparentedContainerIds.push(child.id);
    }
    collapseIoNode(sfmDoc, inputId, parentId);
    collapseIoNode(sfmDoc, outputId, parentId);
    removeContainer(sfmDoc, outpostId);
  });

  return { reparentedNodeIds, reparentedEdgeIds, reparentedContainerIds };
}

/**
 * The "Delete Everything" half of the new delete-outpost dialog (see
 * `NodeContextMenu.tsx`/`DeleteOutpostDialog.tsx`) — the destructive
 * counterpart to `deleteOutpost` above. Removes `outpostId` itself, every
 * container nested inside it at any depth, every node living directly in
 * any of those containers (including its own locked `outpost-input`/
 * `outpost-output` pass-through nodes), and every edge touching one of
 * those nodes — **not** just edges whose own `containerId` happens to fall
 * inside the subtree, since (per `portMapping.ts`'s header) an edge's
 * `containerId` records where it was drawn, not whether it crosses a
 * boundary; a boundary-crossing edge reaching OUT of the deleted subtree
 * must be deleted too; leaving it would dangle a reference to a node that no
 * longer exists.
 *
 * Throws under the same conditions `deleteOutpost` does (unknown id, or the
 * root container).
 */
export function deleteOutpostWithContents(sfmDoc: SfmDocument, outpostId: string): void {
  const outpost = getContainer(sfmDoc, outpostId);
  if (!outpost) {
    throw new Error(`deleteOutpostWithContents: no container with id "${outpostId}"`);
  }
  if (outpost.parentId === null) {
    throw new Error("deleteOutpostWithContents: cannot delete the root container");
  }

  const allContainers = listContainers(sfmDoc);
  const parentOf = buildContainerParentMap(allContainers);
  const deletedContainerIds = new Set(
    allContainers.filter((c) => isContainerWithinSubtree(c.id, outpostId, parentOf)).map((c) => c.id),
  );
  const deletedNodeIds = new Set(
    listNodes(sfmDoc).filter((node) => deletedContainerIds.has(node.containerId)).map((node) => node.id),
  );

  sfmDoc.doc.transact(() => {
    for (const edge of listEdges(sfmDoc)) {
      if (deletedNodeIds.has(edge.fromNode) || deletedNodeIds.has(edge.toNode)) {
        removeEdge(sfmDoc, edge.id);
      }
    }
    for (const nodeId of deletedNodeIds) removeNode(sfmDoc, nodeId);
    for (const containerId of deletedContainerIds) removeContainer(sfmDoc, containerId);
  });
}
