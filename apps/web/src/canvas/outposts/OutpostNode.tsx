// Job 013: how an outpost renders from *outside* itself — "a single node
// with input/output ports" (PLAN.md §2's Outposts row). The port list comes
// straight from `data.ports` (`useYjsSync.ts`'s `containerToOutpostFlowNode`
// — itself `outposts/portMapping.ts`'s `computeOutpostPorts`, recomputed
// fresh on every resync, never stored on the `Container` record).
//
// Visually deliberately minimal (dashed border, no icons/theming) — this is
// "functionally correct, not polished"; Job 014's visual pass owns styling
// outpost nodes for real (see jobs/013-outposts.md's Handoff notes for what
// it needs to know).
import { memo } from "react";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { useCanvasDoc } from "../CanvasDocContext";
import type { CanvasNode } from "../useYjsSync";

const inHandleClass = "!h-2.5 !w-2.5 !border-amber-400 !bg-amber-700";
const outHandleClass = "!h-2.5 !w-2.5 !border-amber-400 !bg-amber-700";

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
      className={`w-56 rounded-md border-2 border-dashed bg-neutral-900/80 text-neutral-100 shadow-lg ${
        selected ? "border-indigo-500" : "border-amber-600"
      }`}
      onDoubleClick={open}
    >
      <div className="flex items-center gap-2 rounded-t-md border-b border-neutral-800 bg-neutral-950/60 px-2 py-1.5">
        <span aria-hidden className="text-base leading-none">
          📦
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-neutral-100">{container.title || "Outpost"}</p>
          <p className="truncate text-[10px] text-neutral-500">Outpost · double-click to open</p>
        </div>
        <button
          type="button"
          className="nodrag shrink-0 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:bg-neutral-700"
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
          title="Open this outpost"
        >
          Open →
        </button>
      </div>

      <div className="divide-y divide-neutral-800/60 py-0.5">
        {ports.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-neutral-500">
            No connections cross this outpost&apos;s boundary yet.
          </p>
        ) : (
          ports.map((port) => (
            <div key={port.id} className="relative flex items-center gap-1.5 px-2 py-1 text-[11px]">
              {port.direction === "in" && (
                <Handle type="target" position={Position.Left} id={port.id} className={inHandleClass} />
              )}
              <span className="min-w-0 flex-1 truncate text-neutral-200">
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
