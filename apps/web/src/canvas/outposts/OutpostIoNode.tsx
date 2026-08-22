// Outpost/Blueprint rework: the two permanent, non-removable pass-through
// nodes rendered INSIDE an outpost/blueprint (`io.ts`'s `outpost-input`/
// `outpost-output` kinds) — "Inputs" and "Outputs". Modeled closely on
// `SplurgerNode.tsx` (a real node whose ports are driven entirely by
// whichever edges happen to be wired to it, not a fixed recipe part list).
// Only the INTERNAL-facing side is ever a live drop target from inside this
// view — the connection is entirely driven by real wires (this card's own
// `<Handle>`s, plus the outer boundary card's), so there's no separate
// read-only "what's connected from outside" list to keep in sync with them;
// an external connection is visible from here only as this same row's rate
// updating, not as a second, duplicate listing.
//
// Not erased into the solver directly (same as a Splurger) — its incident
// edges are rewritten into direct recipe-to-recipe edges by
// `workers/buildSnapshot.ts` reusing `workers/splurgerPassthrough.ts`'s
// `computeSplurgerPassthroughEdges` verbatim. `useSolver.ts`'s `indexEdges`
// separately aliases each unambiguous original edge id to its synthetic
// result (`computePassthroughEdgeAliases`); `io.ts`'s `computeIoPartRate`
// builds on that (plus a same-node-rate fallback for a still-one-sided
// connection) so this component never needs its own local recomputation.
import { X } from "lucide-react";
import { memo } from "react";

import { getNode, listEdges, removeEdge, type EdgeRecord, type NodeRecord } from "@scm/ydoc";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import { WILDCARD_PART, isValidDragCandidate } from "../edges/connectionLogic";
import { classifyEdgeValidity } from "../edges/classifyEdgeValidity";
import { useCanvasDoc } from "../CanvasDocContext";
import { formatRate } from "../formatRate";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasNode } from "../useYjsSync";
import { OUTPOST_OUTPUT_KIND, computeIoDanglingParts, computeIoNodePorts, computeIoPartRate } from "./io";

const handleClass = "!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--outpost)]";
const handleFadeClass = "opacity-20 pointer-events-none transition-opacity";

function ringClass(validity: ReturnType<typeof classifyEdgeValidity>): string | undefined {
  if (validity === "invalid") return "ring-2 ring-[var(--danger)]";
  if (validity === "mismatched") return "ring-2 ring-[var(--mismatch)]";
  return undefined;
}

interface ConnectionRow {
  edge: EdgeRecord;
  direction: "in" | "out";
}

export const OutpostIoNode = memo(function OutpostIoNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc } = useCanvasDoc();
  const { edgeResultById, nodeResultById } = useSolverResult();
  const numberFormats = useSettings(sfmDoc).numberFormats;
  const fromHandle = useConnection((connection) => connection.fromHandle);
  const maybeNode = data.record;
  if (!maybeNode) return null;
  const node: NodeRecord = maybeNode;

  const isOutputNode = node.kind === OUTPOST_OUTPUT_KIND;
  // Inputs node: internal-facing side is "out" (feeds internal consumers).
  // Outputs node: internal-facing side is "in" (fed by internal producers).
  const internalDirection: "in" | "out" = isOutputNode ? "in" : "out";

  const allEdges = listEdges(sfmDoc);
  const internalRows: ConnectionRow[] = allEdges
    .filter((edge) => (internalDirection === "in" ? edge.toNode === id : edge.fromNode === id))
    .map((edge) => ({ edge, direction: internalDirection }))
    .sort((a, b) => a.edge.id.localeCompare(b.edge.id));
  const externalRowCount = allEdges.filter((edge) =>
    internalDirection === "in" ? edge.fromNode === id : edge.toNode === id,
  ).length;

  const ports = computeIoNodePorts(allEdges, id);
  const danglingParts = [...computeIoDanglingParts(allEdges, id, internalDirection)];
  const unsupported = internalRows.length > 1 && externalRowCount > 1;

  function validityForEdge(edgeId: string) {
    return classifyEdgeValidity(edgeResultById.get(edgeId));
  }

  function isHandleFaded(handleId: string, type: "source" | "target"): boolean {
    if (!fromHandle) return false;
    if (fromHandle.nodeId === id && fromHandle.id === handleId) return false;
    return !isValidDragCandidate(sfmDoc, fromHandle, { nodeId: id, id: handleId, type });
  }

  function neighborTitle(row: ConnectionRow): string {
    const neighborId = row.direction === "in" ? row.edge.fromNode : row.edge.toNode;
    return getNode(sfmDoc, neighborId)?.title || neighborId;
  }

  const handleType: "source" | "target" = internalDirection === "out" ? "source" : "target";
  const handlePosition = internalDirection === "out" ? Position.Right : Position.Left;

  return (
    <div
      className={`w-64 rounded-lg border-2 border-[var(--outpost-border)] bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors ${
        selected ? "outline outline-2 outline-offset-2 outline-[var(--accent)]" : ""
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5">
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--outpost)]/90 text-[10px] font-bold text-[var(--accent-contrast)] shadow-inner"
        >
          {isOutputNode ? "OUT" : "IN"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--node-header-text)]">{isOutputNode ? "Outputs" : "Inputs"}</p>
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">
            {isOutputNode ? "Leaves this outpost" : "Enters this outpost"}
          </p>
        </div>
      </div>

      {unsupported && (
        <p className="mx-2 mt-1.5 rounded-md bg-[var(--danger-soft)] px-2 py-1 text-[10px] text-[var(--danger)]">
          Multiple sources and multiple destinations for the same item isn't supported here.
        </p>
      )}
      {danglingParts.length > 0 && (
        <p className="mx-2 mt-1.5 rounded-md bg-[var(--danger-soft)] px-2 py-1 text-[10px] text-[var(--danger)]">
          {danglingParts.join(", ")} wired on only one side — connect the other side or remove it.
        </p>
      )}

      {/* One row per distinct part touching this node from EITHER side — a real, connectable handle on the internal-facing side, plus a wildcard "add new" row. */}
      <div className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] py-0.5">
        {ports.map(({ part }) => {
          const rows = internalRows.filter((row) => row.edge.part === part);
          const worstValidity = rows
            .map((row) => validityForEdge(row.edge.id))
            .reduce<ReturnType<typeof classifyEdgeValidity>>((worst, current) => {
              const rank: Record<ReturnType<typeof classifyEdgeValidity>, number> = {
                invalid: 3,
                mismatched: 2,
                unknown: 1,
                valid: 0,
              };
              return rank[current] > rank[worst] ? current : worst;
            }, "valid");
          const handleId = `${internalDirection}:${part}`;
          const iconUrl = getIconUrl(part);
          const rate = computeIoPartRate(allEdges, id, part, edgeResultById, nodeResultById);
          const dangling = danglingParts.includes(part);
          const neighbors = rows.map((row) => neighborTitle(row)).join(", ");
          return (
            <div
              key={handleId}
              className={`relative flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)] ${dangling ? "bg-[var(--danger-soft)]" : ""}`}
              title={
                dangling
                  ? `${part} wired on only one side — connect the other side to route it through.`
                  : neighbors || undefined
              }
            >
              {internalDirection === "in" && (
                <Handle
                  type={handleType}
                  position={handlePosition}
                  id={handleId}
                  className={`${handleClass} ${ringClass(worstValidity) ?? ""} ${isHandleFaded(handleId, handleType) ? handleFadeClass : ""}`}
                />
              )}
              {iconUrl ? (
                <img src={iconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5" />
              ) : (
                <span className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                {internalDirection === "in" ? "→ " : ""}
                {part}
                {internalDirection === "out" ? " →" : ""}
              </span>
              {rate && (
                <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                  {formatRate(rate, numberFormats)}/min
                </span>
              )}
              {rows.length > 0 && !data.readOnly && (
                <button
                  type="button"
                  title="Disconnect the internal side"
                  aria-label={`Disconnect ${part} from inside this outpost`}
                  onClick={() => rows.forEach((row) => removeEdge(sfmDoc, row.edge.id))}
                  className="nodrag shrink-0 rounded px-1 text-[var(--text-muted)] hover:text-[var(--danger)]"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
              {internalDirection === "out" && (
                <Handle
                  type={handleType}
                  position={handlePosition}
                  id={handleId}
                  className={`${handleClass} ${ringClass(worstValidity) ?? ""} ${isHandleFaded(handleId, handleType) ? handleFadeClass : ""}`}
                />
              )}
            </div>
          );
        })}
        {/* Always-present "+" affordance for wiring a brand-new item. */}
        <div className="relative flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--text-muted)]">
          {internalDirection === "in" && (
            <Handle
              type={handleType}
              position={handlePosition}
              id={`in:${WILDCARD_PART}`}
              className={`${handleClass} ${isHandleFaded(`in:${WILDCARD_PART}`, handleType) ? handleFadeClass : ""}`}
            />
          )}
          <span className="flex-1 italic">Drag a wire here to add a connection</span>
          {internalDirection === "out" && (
            <Handle
              type={handleType}
              position={handlePosition}
              id={`out:${WILDCARD_PART}`}
              className={`${handleClass} ${isHandleFaded(`out:${WILDCARD_PART}`, handleType) ? handleFadeClass : ""}`}
            />
          )}
        </div>
      </div>
    </div>
  );
});
