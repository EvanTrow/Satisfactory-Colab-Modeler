// AWESOME Sink / Dimensional Depot Uploader — shared component for
// `kind: "sink"` and `kind: "depot"` (they differ only in `node.machine`/
// default title/icon; every other behavior is identical). Terminal,
// input-only node: one wildcard input `Handle` (`in:*`, same `WILDCARD_PART`
// convention `SplurgerNode.tsx` established — no changes needed to
// `edges/connectionLogic.ts`), accepting any number of distinct parts at
// once, each independently capped by this node's own single Limit field
// (ppm-only — there's no "machine count" concept for a sink, unlike a real
// recipe node's Limit field).
//
// Per-connected-part consumed rate is read from the solver's own synthetic
// per-part consumer node (`../../workers/sinkPassthrough.ts`'s
// `sinkConsumerNodeId`), NOT from a per-edge lookup — see that module's
// header for why (same accepted limitation `SplurgerNode.tsx`'s rewrite
// already has: the incident edge's own id isn't preserved through the
// rewrite, so `edgeResultById` has nothing under the original edge id).
import { memo } from "react";

import { getNode, listEdges, updateNode, type NodeRecord } from "@scm/ydoc";
import { parseRational, toFractionString } from "@scm/rational";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { sinkConsumerNodeId } from "../../workers/sinkPassthrough";
import { useCanvasDoc } from "../CanvasDocContext";
import { WILDCARD_PART, isValidDragCandidate } from "../edges/connectionLogic";
import { formatRate } from "../formatRate";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasNode } from "../useYjsSync";
import { fieldInputClass } from "./nodeFieldStyles";
import { useCommittedTextField } from "./useCommittedTextField";

const handleClass = "!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--splurger)]";
const handleFadeClass = "opacity-20 pointer-events-none transition-opacity";

function defaultLabel(node: NodeRecord): string {
  return node.machine || (node.kind === "depot" ? "Dimensional Depot Uploader" : "AWESOME Sink");
}

export const SinkNode = memo(function SinkNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc } = useCanvasDoc();
  const { nodeResultById } = useSolverResult();
  const numberFormats = useSettings(sfmDoc).numberFormats;
  const fromHandle = useConnection((connection) => connection.fromHandle);
  const node: NodeRecord | undefined = data.record;
  if (!node) return null;

  const inHandleId = `in:${WILDCARD_PART}`;
  const isHandleFaded =
    !!fromHandle && !(fromHandle.nodeId === id && fromHandle.id === inHandleId) &&
    !isValidDragCandidate(fromHandle, { nodeId: id, id: inHandleId, type: "target" });

  const incoming = listEdges(sfmDoc).filter((edge) => edge.toNode === id);
  const distinctParts = [...new Set(incoming.map((edge) => edge.part))].sort();

  function commitLimit(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) {
      updateNode(sfmDoc, id, { limit: null });
      return true;
    }
    try {
      const parsed = parseRational(trimmed);
      updateNode(sfmDoc, id, { limit: toFractionString(parsed) });
      return true;
    } catch {
      return false;
    }
  }

  const limitField = useCommittedTextField(node.limit ?? "", commitLimit);
  const iconUrl = getIconUrl(defaultLabel(node));

  return (
    <div
      className={`relative w-56 rounded-lg border-2 bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors ${
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
          {node.title || defaultLabel(node)}
        </p>
      </div>

      <Handle
        type="target"
        position={Position.Left}
        id={inHandleId}
        className={`${handleClass} ${isHandleFaded ? handleFadeClass : ""}`}
      />

      <div className="divide-y divide-[var(--border-subtle)] py-0.5">
        {distinctParts.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">No connections yet — drag a wire to the input.</p>
        ) : (
          distinctParts.map((part) => {
            const consumerId = sinkConsumerNodeId(id, part);
            const rateStr = nodeResultById.get(consumerId)?.partRates[part];
            const neighborTitles = incoming
              .filter((edge) => edge.part === part)
              .map((edge) => getNode(sfmDoc, edge.fromNode)?.title || edge.fromNode)
              .join(", ");
            return (
              <div key={part} className="flex items-center justify-between gap-1.5 px-2 py-1 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]" title={neighborTitles}>
                  {part} <span className="text-[var(--text-muted)]">({neighborTitles})</span>
                </span>
                {rateStr !== undefined && (
                  <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                    {formatRate(parseRational(rateStr), numberFormats)}/min
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-2 py-1.5 text-[11px]">
        <span className="text-[var(--text-secondary)]">Limit (ppm)</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="unlimited"
          className={`${fieldInputClass} placeholder:italic placeholder:text-[var(--text-muted)]`}
          {...limitField}
        />
      </div>
    </div>
  );
});
