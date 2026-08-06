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
  getContainer,
  listContainers,
  listEdgesByContainer,
  listNodesByContainer,
  removeContainer,
  reparentEdge,
  updateContainer,
  updateNode,
} from "@scm/ydoc";

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
 * simply stops finding a crossing.
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

  const reparentedNodeIds: string[] = [];
  const reparentedEdgeIds: string[] = [];
  const reparentedContainerIds: string[] = [];

  sfmDoc.doc.transact(() => {
    for (const node of listNodesByContainer(sfmDoc, outpostId)) {
      updateNode(sfmDoc, node.id, { containerId: parentId });
      reparentedNodeIds.push(node.id);
    }
    for (const edge of listEdgesByContainer(sfmDoc, outpostId)) {
      reparentEdge(sfmDoc, edge.id, parentId);
      reparentedEdgeIds.push(edge.id);
    }
    const nestedChildren: Container[] = listContainers(sfmDoc).filter((c) => c.parentId === outpostId);
    for (const child of nestedChildren) {
      updateContainer(sfmDoc, child.id, { parentId });
      reparentedContainerIds.push(child.id);
    }
    removeContainer(sfmDoc, outpostId);
  });

  return { reparentedNodeIds, reparentedEdgeIds, reparentedContainerIds };
}
