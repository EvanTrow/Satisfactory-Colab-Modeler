// Job 013: right-click-on-a-node context menu, the entry point for "moving
// a node into/out of an outpost... a context-menu 'move to container'
// action" (this job's own Scope wording) and for "delete an outpost"
// (reparent-not-destroy, see `outposts/reparent.ts`). Deliberately a
// separate, minimal floating menu rather than extending `RecipeNode.tsx`'s
// existing per-port `onContextMenu` (Job 011's "right-click a part label"
// removes just that port's edges — a different gesture, on a different
// target) — this one fires on `<ReactFlow onNodeContextMenu>`, i.e.
// anywhere on a node that isn't a part row.
import { useRef } from "react";

import { type Container, type NodeRecord, type NumberFormats } from "@scm/ydoc";

import { useFocusTrap } from "../../a11y";
import { RecipeNodeQuickSettings } from "../nodes";

export interface NodeContextMenuState {
  nodeId: string;
  /**
   * `"outpost"`/`"blueprint"` when the right-clicked node is a Job
   * 013/026 container boundary node (`data.container` set), `null` for a
   * real recipe node. Job 026 widened this from a plain `isOutpost:
   * boolean` so the menu can offer the right "Convert to..." action for
   * whichever kind it currently is.
   */
  containerKind: "outpost" | "blueprint" | null;
  /**
   * The right-clicked node's own record, when it's a `kind: "recipe"` node
   * (`data.record`) — drives the quick settings section below (name, clock
   * speed, auto-round, somersloops). `undefined` for a container boundary
   * node or any other node kind that doesn't have these fields exposed on
   * its own card.
   */
  recipeRecord?: NodeRecord;
  /** Viewport/screen coordinates to anchor the menu at — same convention `RecipeChooser.tsx` (Job 009) uses. */
  screenPosition: { x: number; y: number };
}

export interface NodeContextMenuProps {
  state: NodeContextMenuState;
  /** Outposts/blueprints visible in the *current* view (i.e. `data.container` nodes other than `state.nodeId` itself) — candidate "move into" targets for a real node. */
  siblingOutposts: Container[];
  /** The current view's own parent container, or `null` at root (root has nothing to move "up" into). */
  parentContainer: Container | null;
  onMoveToContainer: (nodeId: string, containerId: string) => void;
  onOpenOutpost: (containerId: string) => void;
  onDeleteOutpost: (containerId: string) => void;
  /** Job 026: flips `Container.kind` between `"outpost"` and `"blueprint"` — the blueprint creation/conversion UI this job's own scope asks for ("an outpost can be marked/converted to `kind: 'blueprint'`"). */
  onConvertContainerKind: (containerId: string, kind: "outpost" | "blueprint") => void;
  /** Only needed to render `state.recipeRecord`'s quick settings section — unused for a container boundary node. */
  numberFormats: NumberFormats;
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
  onConvertContainerKind,
  numberFormats,
  onClose,
}: NodeContextMenuProps) {
  // Job 029: this menu's *trigger* (right-click a node) has no keyboard
  // equivalent in this app — a genuine, documented limitation (see
  // jobs/029's Handoff notes) rather than an oversight, since a context
  // menu is inherently a pointer-driven affordance and there's no separate
  // discoverable keyboard entry point to it anywhere else in this app's UI.
  // Once it IS open, though, it should behave like any other floating
  // panel: Escape closes it, Tab doesn't leak focus out to the canvas
  // behind it, and closing returns focus sensibly — the same focus trap
  // `RecipeChooser`/`SettingsMenu`/`SharingPanel`/`VersionPanel` all use.
  const menuRef = useRef<HTMLDivElement>(null);
  useFocusTrap(menuRef, true, { onClose });

  return (
    // Backdrop: click anywhere else closes the menu without acting — same pattern `RecipeChooser.tsx` uses.
    // The quick-settings name/clock fields (`useCommittedTextField`) only
    // commit on blur, and a plain `onClose()` here would unmount the menu
    // (and its focused input) on this same `mousedown` — before the browser
    // gets to the focus-change step that would normally fire that blur — so
    // any pending edit was silently dropped. Blurring the active element
    // ourselves first forces that commit to run while the field is still
    // mounted, then `onClose` proceeds as before.
    <div
      className="fixed inset-0 z-50"
      onMouseDown={() => {
        if (menuRef.current?.contains(document.activeElement)) {
          (document.activeElement as HTMLElement).blur();
        }
        onClose();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label="Node actions"
        className="absolute min-w-[200px] rounded-lg border border-[var(--border-default)] bg-[var(--surface-panel)] p-1 text-[var(--text-primary)] shadow-[var(--shadow-modal)]"
        style={{ left: state.screenPosition.x, top: state.screenPosition.y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {state.containerKind ? (
          <>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                onOpenOutpost(state.nodeId);
                onClose();
              }}
            >
              Open {state.containerKind}
            </button>
            {/* Job 026: blueprint creation/conversion — "an outpost can be marked/converted to kind: 'blueprint'" (jobs/026-blueprints.md's own scope wording), and reversible the same way. */}
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                onConvertContainerKind(state.nodeId, state.containerKind === "outpost" ? "blueprint" : "outpost");
                onClose();
              }}
              title={
                state.containerKind === "outpost"
                  ? "Makes this outpost duplicable — put a limit on something inside to define one copy; the copy count is then computed from external demand."
                  : "Converts back to a plain (non-duplicable) outpost."
              }
            >
              Convert to {state.containerKind === "outpost" ? "blueprint" : "outpost"}
            </button>
            <button
              type="button"
              className={`${itemClass} text-[var(--danger)] hover:bg-[var(--danger-soft)]`}
              onClick={() => {
                onDeleteOutpost(state.nodeId);
                onClose();
              }}
              title={`Deletes the ${state.containerKind} container itself; everything inside it is kept, reparented to this container.`}
            >
              Delete {state.containerKind} (keep contents)
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
            {state.recipeRecord && (
              <>
                <div className="my-1 border-t border-[var(--border-subtle)]" />
                <RecipeNodeQuickSettings record={state.recipeRecord} numberFormats={numberFormats} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
