// Job 013: right-click-on-a-node context menu, the entry point for "moving
// a node into/out of an outpost... a context-menu 'move to container'
// action" (this job's own Scope wording) and for "delete an outpost"
// (reparent-not-destroy, see `outposts/reparent.ts`). Deliberately a
// separate, minimal floating menu rather than extending `RecipeNode.tsx`'s
// existing per-port `onContextMenu` (Job 011's "right-click a part label"
// removes just that port's edges — a different gesture, on a different
// target) — this one fires on `<ReactFlow onNodeContextMenu>`, i.e.
// anywhere on a node that isn't a part row.
import { type Container } from "@scm/ydoc";

export interface NodeContextMenuState {
  nodeId: string;
  /** True when the right-clicked node is a Job 013 outpost boundary node (`data.container` set), not a real recipe node. */
  isOutpost: boolean;
  /** Viewport/screen coordinates to anchor the menu at — same convention `RecipeChooser.tsx` (Job 009) uses. */
  screenPosition: { x: number; y: number };
}

export interface NodeContextMenuProps {
  state: NodeContextMenuState;
  /** Outposts visible in the *current* view (i.e. `data.container` nodes other than `state.nodeId` itself) — candidate "move into" targets for a real node. */
  siblingOutposts: Container[];
  /** The current view's own parent container, or `null` at root (root has nothing to move "up" into). */
  parentContainer: Container | null;
  onMoveToContainer: (nodeId: string, containerId: string) => void;
  onOpenOutpost: (containerId: string) => void;
  onDeleteOutpost: (containerId: string) => void;
  onClose: () => void;
}

const itemClass = "block w-full rounded-md px-2 py-1.5 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-hover)]";

export function NodeContextMenu({
  state,
  siblingOutposts,
  parentContainer,
  onMoveToContainer,
  onOpenOutpost,
  onDeleteOutpost,
  onClose,
}: NodeContextMenuProps) {
  return (
    // Backdrop: click anywhere else closes the menu without acting — same pattern `RecipeChooser.tsx` uses.
    <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(event) => event.preventDefault()}>
      <div
        className="absolute min-w-[200px] rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-1 text-[var(--text-primary)] shadow-[var(--shadow-modal)]"
        style={{ left: state.screenPosition.x, top: state.screenPosition.y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {state.isOutpost ? (
          <>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                onOpenOutpost(state.nodeId);
                onClose();
              }}
            >
              Open outpost
            </button>
            <button
              type="button"
              className={`${itemClass} text-[var(--danger)] hover:bg-[var(--danger-soft)]`}
              onClick={() => {
                onDeleteOutpost(state.nodeId);
                onClose();
              }}
              title="Deletes the outpost container itself; everything inside it is kept, reparented to this container."
            >
              Delete outpost (keep contents)
            </button>
          </>
        ) : (
          <>
            {parentContainer && (
              <button
                type="button"
                className={itemClass}
                onClick={() => {
                  onMoveToContainer(state.nodeId, parentContainer.id);
                  onClose();
                }}
              >
                Move to parent ({parentContainer.title || "container"})
              </button>
            )}
            {siblingOutposts.length === 0 && !parentContainer && (
              <p className="px-2 py-1.5 text-xs text-[var(--text-muted)]">No outposts here to move into.</p>
            )}
            {siblingOutposts.map((outpost) => (
              <button
                key={outpost.id}
                type="button"
                className={itemClass}
                onClick={() => {
                  onMoveToContainer(state.nodeId, outpost.id);
                  onClose();
                }}
              >
                Move into {outpost.title || "Outpost"}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
