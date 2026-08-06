// Job 013: how an outpost renders from *outside* itself — "a single node
// with input/output ports" (PLAN.md §2's Outposts row). The port list comes
// straight from `data.ports` (`useYjsSync.ts`'s `containerToOutpostFlowNode`
// — itself `outposts/portMapping.ts`'s `computeOutpostPorts`, recomputed
// fresh on every resync, never stored on the `Container` record).
//
// Visually minimal by design through Job 013 (dashed border, emoji icon,
// no theming) — Job 014's visual pass (this version) restyles it to match
// `RecipeNode.tsx`'s card language: the same `--node-header`/`--surface-card`
// tokens, `rounded-lg` radius, and 2px border, plus its own `--outpost`
// accent (amber, kept distinct from the indigo selection color and from
// `RecipeNode`'s neutral chrome — see `index.css`'s token-block comment on
// why outposts keep their own amber identity rather than adopting
// Ferrumium's literal accent color) so an outpost reads as "a distinct kind
// of node," not just "a recipe node with different data," at a glance.
import { memo } from "react";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { getOutpostIconUrl } from "../../assets/icons";
import { useCanvasDoc } from "../CanvasDocContext";
import type { CanvasNode } from "../useYjsSync";

const outpostIconUrl = getOutpostIconUrl();

const inHandleClass = "!h-2.5 !w-2.5 !border-2 !border-[var(--surface-card)] !bg-[var(--outpost)]";
const outHandleClass = "!h-2.5 !w-2.5 !border-2 !border-[var(--surface-card)] !bg-[var(--outpost)]";

export const OutpostNode = memo(function OutpostNode({ data, selected }: NodeProps<CanvasNode>) {
  const { navigateToContainer } = useCanvasDoc();
  const container = data.container;
  // Defensive only — `containerToOutpostFlowNode` always sets `data.container` for a `type: "outpost"` node.
  if (!container) return null;
  const ports = data.ports ?? [];

  function open() {
    navigateToContainer(container!.id);
  }

  return (
    <div
      // `nodrag` deliberately *not* applied here — the whole card should
      // still be draggable (its position is the container's own `x`/`y`,
      // per `useYjsSync.ts`'s `onNodeDragStop` branch), same as a normal
      // recipe node.
      className={`w-56 cursor-grab rounded-lg border-2 bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors active:cursor-grabbing ${
        selected ? "border-[var(--accent)]" : "border-[var(--outpost-border)]"
      }`}
      onDoubleClick={open}
    >
      <div className="flex items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5">
        {outpostIconUrl ? (
          <img
            src={outpostIconUrl}
            alt=""
            className="h-6 w-6 shrink-0 rounded-md bg-black/20 object-contain p-0.5 shadow-inner"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--outpost)]/90 text-xs font-bold text-[var(--accent-contrast)] shadow-inner"
          >
            OP
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--node-header-text)]">{container.title || "Outpost"}</p>
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">Outpost · double-click to open</p>
        </div>
        <button
          type="button"
          className="nodrag shrink-0 rounded-md border border-[var(--outpost-border)] bg-[var(--outpost-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--node-header-text)] hover:brightness-110"
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
          title="Open this outpost"
        >
          Open →
        </button>
      </div>

      <div className="divide-y divide-[var(--border-subtle)] py-0.5">
        {ports.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
            No connections cross this outpost&apos;s boundary yet.
          </p>
        ) : (
          ports.map((port) => (
            <div
              key={port.id}
              className="relative flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)]"
            >
              {port.direction === "in" && (
                <Handle type="target" position={Position.Left} id={port.id} className={inHandleClass} />
              )}
              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                {port.direction === "in" ? "→ " : ""}
                {port.part}
                {port.direction === "out" ? " →" : ""}
              </span>
              {port.direction === "out" && (
                <Handle type="source" position={Position.Right} id={port.id} className={outHandleClass} />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
});
