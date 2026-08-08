// Storage Container (`kind: "storage"`) — two wildcard `Handle`s (`in:*`
// left, `out:*` right, same `WILDCARD_PART` convention `SplurgerNode.tsx`
// established), unlike a Splurger DELIBERATELY decoupled: input and output
// don't have to balance (that's the whole point — "shows the difference").
// See `../../workers/storagePassthrough.ts`'s header for how that's modeled
// in the solver (one synthetic uncapped consumer per distinct incoming
// part, one synthetic uncapped producer per distinct outgoing part) and why
// per-part rates here are read from THOSE synthetic nodes' own
// `NodeSolveResult.partRates` rather than from a per-edge lookup.
//
// `node.storageMode` exposes all four `STORAGE_MODES` (PLAN.md §2's
// "Partially Full / Full / Empty / Input = Output"), but only the default
// `"partiallyFull"` has real solver behavior as of this addition — the
// other three would each need genuinely different solver semantics
// (`"full"`/`"empty"` behave like an always-available/never-accepting
// source or sink; `"inputEqualsOutput"` is real conservation, like a
// Splurger) and aren't implemented yet. Selecting one of them just changes
// what's stored on the record; it doesn't change how this node solves.
// Flagged here rather than silently pretending it works, same posture
// `SplurgerNode.tsx`'s own "unsupported shape" banner takes.
//
// A Storage Container is allowed to carry more than one distinct part at
// once (this job's own scope decision — allow it, flag visually, rather
// than blocking the connection) — the banner below fires whenever this
// node's own incident edges touch more than one distinct part.
import { memo } from "react";

import { getNode, listEdges, updateNode, STORAGE_MODES, type NodeRecord, type StorageMode } from "@scm/ydoc";
import { abs, isNegative, isZero, parseRational, subtract, ZERO, type Rational } from "@scm/rational";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { storageConsumerNodeId, storageProducerNodeId } from "../../workers/storagePassthrough";
import { useCanvasDoc } from "../CanvasDocContext";
import { WILDCARD_PART, isValidDragCandidate } from "../edges/connectionLogic";
import { formatRate } from "../formatRate";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasNode } from "../useYjsSync";

const handleClass = "!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--splurger)]";
const handleFadeClass = "opacity-20 pointer-events-none transition-opacity";

const STORAGE_MODE_LABELS: Record<StorageMode, string> = {
  partiallyFull: "Partially Full",
  full: "Full",
  empty: "Empty",
  inputEqualsOutput: "Input = Output",
};

export const StorageNode = memo(function StorageNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc } = useCanvasDoc();
  const { nodeResultById } = useSolverResult();
  const numberFormats = useSettings(sfmDoc).numberFormats;
  const fromHandle = useConnection((connection) => connection.fromHandle);
  const node: NodeRecord | undefined = data.record;
  if (!node) return null;

  function isHandleFaded(handleId: string, type: "source" | "target"): boolean {
    if (!fromHandle) return false;
    if (fromHandle.nodeId === id && fromHandle.id === handleId) return false;
    return !isValidDragCandidate(fromHandle, { nodeId: id, id: handleId, type });
  }

  const allEdges = listEdges(sfmDoc);
  const incoming = allEdges.filter((edge) => edge.toNode === id);
  const outgoing = allEdges.filter((edge) => edge.fromNode === id);
  const distinctParts = [...new Set([...incoming, ...outgoing].map((edge) => edge.part))].sort();
  const isMultiPart = distinctParts.length > 1;

  function neighborTitles(part: string): string {
    const inTitles = incoming.filter((e) => e.part === part).map((e) => getNode(sfmDoc, e.fromNode)?.title || e.fromNode);
    const outTitles = outgoing.filter((e) => e.part === part).map((e) => getNode(sfmDoc, e.toNode)?.title || e.toNode);
    return [...inTitles, ...outTitles].join(", ");
  }

  function rateFor(nodeId: string, part: string): Rational | undefined {
    const rateStr = nodeResultById.get(nodeId)?.partRates[part];
    return rateStr !== undefined ? parseRational(rateStr) : undefined;
  }

  const iconUrl = getIconUrl("Storage Container");

  return (
    <div
      className={`relative w-64 rounded-lg border-2 bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors ${
        selected ? "border-[var(--accent)]" : "border-[var(--border-strong)]"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5">
        {iconUrl ? (
          <img src={iconUrl} alt="" className="h-6 w-6 shrink-0 rounded-md bg-black/20 object-contain p-0.5 shadow-inner" />
        ) : (
          <span className="h-6 w-6 shrink-0 rounded-md bg-black/20" aria-hidden />
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--node-header-text)]">
          {node.title || "Storage Container"}
        </p>
      </div>

      <Handle
        type="target"
        position={Position.Left}
        id={`in:${WILDCARD_PART}`}
        className={`${handleClass} ${isHandleFaded(`in:${WILDCARD_PART}`, "target") ? handleFadeClass : ""}`}
      />
      <Handle
        type="source"
        position={Position.Right}
        id={`out:${WILDCARD_PART}`}
        className={`${handleClass} ${isHandleFaded(`out:${WILDCARD_PART}`, "source") ? handleFadeClass : ""}`}
      />

      {isMultiPart && (
        <p className="mx-2 mt-1.5 rounded-md bg-[var(--danger-soft)] px-2 py-1 text-[10px] text-[var(--danger)]">
          This Storage Container is carrying more than one item type at once — each is tracked independently below.
        </p>
      )}

      <div className="divide-y divide-[var(--border-subtle)] py-0.5">
        {distinctParts.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">No connections yet — drag a wire to either side.</p>
        ) : (
          distinctParts.map((part) => {
            const inRate = rateFor(storageConsumerNodeId(id, part), part);
            const outRate = rateFor(storageProducerNodeId(id, part), part);
            // `inRate` (the synthetic consumer's own rate) is negative — a
            // consumption. `outRate` (the synthetic producer's own rate) is
            // positive — a supply. Net = how fast the container is FILLING
            // (positive) or DRAINING (negative): intake magnitude minus outflow.
            const net = subtract(inRate ? abs(inRate) : ZERO, outRate ?? ZERO);
            return (
              <div key={part} className="flex flex-col gap-0.5 px-2 py-1 text-[11px]" title={neighborTitles(part)}>
                <span className="truncate text-[var(--text-primary)]">{part}</span>
                <div className="flex items-center justify-between text-[var(--text-muted)]">
                  <span>in {inRate ? formatRate(inRate, numberFormats) : "0"}/min</span>
                  <span>out {outRate ? formatRate(outRate, numberFormats) : "0"}/min</span>
                  <span
                    className={
                      isZero(net)
                        ? "text-[var(--text-secondary)]"
                        : isNegative(net)
                          ? "text-[var(--danger)]"
                          : "text-[var(--accent)]"
                    }
                  >
                    net {isNegative(net) ? "-" : "+"}
                    {formatRate(net, numberFormats)}/min
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <label className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-2 py-1.5 text-[11px]">
        <span className="text-[var(--text-secondary)]">Mode</span>
        <select
          value={node.storageMode ?? "partiallyFull"}
          onChange={(event) => updateNode(sfmDoc, id, { storageMode: event.target.value })}
          className="nodrag rounded border border-[var(--border-default)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
        >
          {STORAGE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {STORAGE_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
});
