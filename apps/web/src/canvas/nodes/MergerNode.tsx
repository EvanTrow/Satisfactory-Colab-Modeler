// The Merger buildables — Conveyor Merger (`mergerVariant: "basic"`),
// Priority Merger (`"priority"`). Always 3 inputs (`in:*slot0/1/2`, left,
// top-to-bottom) / 1 output (`out:*`, right) — see
// satisfactory.wiki.gg/wiki/Conveyor_Merger and .../Priority_Merger. Port
// shape is fixed by node kind, matching `SplitterNode.tsx`'s own design.
//
// Priority Merger's 3 input slots each carry an independently configured
// Low/Medium/High priority — a real 3-tier lexicographic drain (High fully
// drains before Medium gets anything, Medium before Low), backed by
// `@scm/solver`'s N-ary `PriorityTier` rank system. A Conveyor Merger
// (`"basic"`) has no priority UI — every input shares one fair pool.
//
// See `workers/splitMergePassthrough.ts`'s header for exactly how a slot's
// priority becomes a solver rank.
import { ArrowRight, X } from "lucide-react";
import { memo } from "react";

import { getNode, listEdges, removeEdge, setPriorityOrder, type EdgeRecord, type NodeRecord } from "@scm/ydoc";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { WILDCARD_PART, isValidDragCandidate } from "../edges/connectionLogic";
import { useCanvasDoc } from "../CanvasDocContext";
import type { CanvasNode } from "../useYjsSync";
import {
  decodeMergerConfig,
  encodeMergerConfig,
  mergerSlotPriority,
  wildcardSlot,
  type MergerPriority,
  type SlotIndex,
} from "./splitMergeConfig";

const handleClass = "!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--splurger)]";
const handleFadeClass = "opacity-20 pointer-events-none transition-opacity";

const VARIANT_LABELS: Record<string, string> = {
  basic: "Conveyor Merger",
  priority: "Priority Merger",
};

const PRIORITY_LABELS: Record<MergerPriority, string> = { high: "High", medium: "Medium", low: "Low" };

const SLOTS: readonly SlotIndex[] = [0, 1, 2];
const SLOT_LABELS: Record<SlotIndex, string> = { 0: "Left", 1: "Center", 2: "Right" };

export const MergerNode = memo(function MergerNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc } = useCanvasDoc();
  const fromHandle = useConnection((connection) => connection.fromHandle);
  const maybeNode = data.record;
  if (!maybeNode) return null;
  const node: NodeRecord = maybeNode;
  const readOnly = Boolean(data.readOnly);

  function isHandleFaded(handleId: string, type: "source" | "target"): boolean {
    if (!fromHandle) return false;
    if (fromHandle.nodeId === id && fromHandle.id === handleId) return false;
    return !isValidDragCandidate(sfmDoc, fromHandle, { nodeId: id, id: handleId, type });
  }

  const variant = node.mergerVariant ?? "basic";
  const configurable = variant === "priority";
  const config = configurable ? decodeMergerConfig(node.priorityOrder) : new Map<SlotIndex, MergerPriority>();

  const allEdges = listEdges(sfmDoc);
  const outRows = allEdges.filter((e) => e.fromNode === id);
  const inRowsBySlot = new Map<SlotIndex, EdgeRecord[]>(SLOTS.map((slot) => [slot, []]));
  for (const edge of allEdges) {
    if (edge.toNode !== id) continue;
    const part = edge.toPort.slice(edge.toPort.indexOf(":") + 1);
    for (const slot of SLOTS) {
      if (part === wildcardSlot(slot)) inRowsBySlot.get(slot)!.push(edge);
    }
  }
  const inRows = SLOTS.flatMap((slot) => inRowsBySlot.get(slot)!);

  const inParts = new Set(inRows.map((e) => e.part));
  const outParts = new Set(outRows.map((e) => e.part));
  const danglingParts = [...new Set([...inParts, ...outParts])].filter(
    (part) => inParts.has(part) !== outParts.has(part),
  );

  function neighborTitle(edge: EdgeRecord, direction: "in" | "out"): string {
    const neighborId = direction === "in" ? edge.fromNode : edge.toNode;
    return getNode(sfmDoc, neighborId)?.title || neighborId;
  }

  function updateSlot(slot: SlotIndex, priority: MergerPriority) {
    const nextConfig = new Map(config);
    nextConfig.set(slot, priority);
    setPriorityOrder(sfmDoc, node.id, encodeMergerConfig(nextConfig));
  }

  return (
    <div
      className={`relative w-72 rounded-lg border-2 border-[var(--splurger-border)] bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors ${
        selected ? "outline outline-2 outline-offset-2 outline-[var(--accent)]" : ""
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5">
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--splurger)]/90 text-[var(--accent-contrast)] shadow-inner overflow-hidden"
        >
          {getIconUrl("Conveyor Merger") ? (
            <img src={getIconUrl("Conveyor Merger")} alt="" className="h-5 w-5 object-contain" />
          ) : (
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--node-header-text)]">{node.title || VARIANT_LABELS[variant]}</p>
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">{VARIANT_LABELS[variant]}</p>
        </div>
      </div>

      <div className="flex items-start justify-between gap-1.5 px-3 py-3">
        <div className="flex flex-1 flex-col gap-1.5">
          {SLOTS.map((slot) => {
            const handleId = `in:${wildcardSlot(slot)}`;
            const slotRows = inRowsBySlot.get(slot)!;
            const priority = mergerSlotPriority(config, slot);
            return (
              <div key={slot} className="flex items-center gap-1.5">
                <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
                  <PortIcon parts={[...new Set(slotRows.map((e) => e.part))]} />
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={handleId}
                    className={`${handleClass} ${isHandleFaded(handleId, "target") ? handleFadeClass : ""}`}
                  />
                </div>
                {configurable && !readOnly ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1">
                    <span className="w-11 shrink-0 text-[10px] text-[var(--text-muted)]">{SLOT_LABELS[slot]}</span>
                    <select
                      className="nodrag min-w-0 flex-1 rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1 py-0.5 text-[10px] text-[var(--text-primary)]"
                      value={priority}
                      onChange={(e) => updateSlot(slot, e.target.value as MergerPriority)}
                    >
                      {(Object.keys(PRIORITY_LABELS) as MergerPriority[]).map((p) => (
                        <option key={p} value={p}>
                          {PRIORITY_LABELS[p]}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <span className="text-[10px] text-[var(--text-muted)]">{SLOT_LABELS[slot]}</span>
                )}
              </div>
            );
          })}
        </div>
        <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
          <PortIcon parts={[...new Set(outRows.map((e) => e.part))]} />
          <Handle
            type="source"
            position={Position.Right}
            id={`out:${WILDCARD_PART}`}
            className={`${handleClass} ${isHandleFaded(`out:${WILDCARD_PART}`, "source") ? handleFadeClass : ""}`}
          />
        </div>
      </div>

      {danglingParts.length > 0 && (
        <p className="mx-2 mb-1.5 rounded-md bg-[var(--danger-soft)] px-2 py-1 text-[10px] text-[var(--danger)]">
          {danglingParts.join(", ")} wired on only one side — connect the other side or remove it.
        </p>
      )}

      {(inRows.length > 0 || outRows.length > 0) && !readOnly && (
        <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] py-0.5">
          {inRows.map((edge) => (
            <ConnectionRow
              key={edge.id}
              edge={edge}
              label={neighborTitle(edge, "in")}
              isDangling={danglingParts.includes(edge.part)}
              onDisconnect={() => removeEdge(sfmDoc, edge.id)}
            />
          ))}
          {outRows.map((edge) => (
            <ConnectionRow
              key={edge.id}
              edge={edge}
              label={neighborTitle(edge, "out")}
              isDangling={danglingParts.includes(edge.part)}
              onDisconnect={() => removeEdge(sfmDoc, edge.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function PortIcon({ parts }: { parts: readonly string[] }) {
  if (parts.length === 0) {
    return (
      <div
        className="flex h-8 w-8 items-center justify-center rounded border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)]"
        aria-hidden
      >
        <span className="h-3 w-3 rounded-full border border-current" />
      </div>
    );
  }
  return (
    <div
      className="relative flex h-8 w-8 items-center justify-center rounded border border-[var(--splurger-border)] bg-[var(--surface-sunken)]"
      title={parts.join(", ")}
    >
      {getIconUrl(parts[0]!) ? (
        <img src={getIconUrl(parts[0]!)} alt="" className="h-6 w-6 object-contain" />
      ) : (
        <span className="h-5 w-5 rounded-sm bg-[var(--surface-hover)]" aria-hidden />
      )}
      {parts.length > 1 && (
        <span className="absolute -right-1 -top-1 rounded-full bg-[var(--splurger)] px-1 text-[9px] font-medium text-[var(--accent-contrast)]">
          +{parts.length - 1}
        </span>
      )}
    </div>
  );
}

interface ConnectionRowProps {
  edge: EdgeRecord;
  label: string;
  isDangling: boolean;
  onDisconnect: () => void;
}

function ConnectionRow({ edge, label, isDangling, onDisconnect }: ConnectionRowProps) {
  const iconUrl = getIconUrl(edge.part);
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)] ${
        isDangling ? "bg-[var(--danger-soft)]" : ""
      }`}
      title={isDangling ? `${edge.part} has nothing on the other side — not routed` : undefined}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5" />
      ) : (
        <span className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
        {edge.part}
        <span className="ml-1 text-[var(--text-muted)]">({label})</span>
      </span>
      <button
        type="button"
        title="Disconnect"
        aria-label={`Disconnect ${edge.part} connection`}
        onClick={onDisconnect}
        className="nodrag shrink-0 rounded px-1 text-[var(--text-muted)] hover:text-[var(--danger)]"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
