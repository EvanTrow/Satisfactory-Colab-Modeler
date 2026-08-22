// Storage Container (`kind: "storage"`) — two wildcard `Handle`s (`in:*`
// left, `out:*` right, same `WILDCARD_PART` convention `SplurgerNode.tsx`
// established), unlike a Splurger DELIBERATELY decoupled: input and output
// don't have to balance (that's the whole point — "shows the difference").
// See `../../workers/storagePassthrough.ts`'s header for how that's modeled
// in the solver (one synthetic uncapped consumer for the incoming part, one
// synthetic producer for the outgoing part — capped at the consumer's own
// resolved rate, since a real buffer can never emit more than it received)
// and why the net rate here is read from THOSE synthetic nodes' own
// `NodeSolveResult.partRates` rather than from a per-edge lookup.
//
// Redesign pass: dropped `node.storageMode` (PLAN.md §2's "Partially Full /
// Full / Empty / Input = Output") entirely — only the default
// `"partiallyFull"` behavior was ever real (the other three would each need
// genuinely different solver semantics that were never implemented), so the
// picker was pure clutter offering three modes that silently did nothing.
// The field itself stays on `NodeRecord` (an open `string | null`, no
// migration needed per `packages/ydoc/src/schema.ts`'s own note) — this
// component just stops reading/writing it.
//
// Also dropped multi-item support: a Storage Container now holds exactly ONE
// item type, enforced at connection time by `edges/connectionLogic.ts`'s
// `isStorageConnectionAllowed` (mirroring a Dimensional Depot Uploader's own
// single-item restriction). That collapses this card down to a single row —
// styled after `RecipeNode.tsx`'s own `PartRow`, but with both the input AND
// output `Handle` on that same row (a Constructor needs two rows, one per
// direction, because its input and output are usually different parts; a
// Storage Container's input and output are always the SAME part, so one row
// covers both) — showing just the net rate (positive = filling, negative =
// draining) rather than separate in/out readouts.
//
// The card header's own icon switches on whether the held part is a
// fluid/gas (`@scm/gamedata`'s `Part.fluid`) — the real Storage Container
// building only ever holds solid items, so a fluid/gas part is shown with
// the Fluid Buffer building's icon instead, matching which real building
// would actually hold it. Falls back to the plain Storage Container icon
// before any item is known (nothing connected yet).
import { memo } from "react";

import { defaultGameData } from "@scm/gamedata";
import { getNode, listEdges, type NodeRecord } from "@scm/ydoc";
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
import { computeMismatchDetails } from "./computeMismatchDetails";
import { computeNodeValidityState } from "./computeValidity";
import type { RecipeNodeValidity } from "./validityState";

const handleClass = "!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--splurger)]";
const handleFadeClass = "opacity-20 pointer-events-none transition-opacity";

/** Same mapping `RecipeNode.tsx`'s own `highlightRingClass` uses — see `SinkNode.tsx`'s identical local copy for why this isn't shared/exported. */
function rowRingClass(validity: RecipeNodeValidity | undefined): string {
  if (validity === "invalid") return "ring-1 ring-inset ring-[var(--danger)]";
  if (validity === "mismatched") return "ring-1 ring-inset ring-[var(--mismatch)]";
  if (validity === "unresolved") return "ring-1 ring-inset ring-[var(--warning)]";
  return "";
}

/** `invalid > mismatched > unresolved > valid` — same severity order `computeValidity.ts`'s own `escalate` uses, for combining the row's independent in-side and out-side validity into one. `undefined` (no result for that side at all) never wins over an actual reading from the other side. */
const SEVERITY_ORDER: readonly RecipeNodeValidity[] = ["invalid", "mismatched", "unresolved", "valid"];
function worseValidity(a: RecipeNodeValidity | undefined, b: RecipeNodeValidity | undefined): RecipeNodeValidity | undefined {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

export const StorageNode = memo(function StorageNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc } = useCanvasDoc();
  const { nodeResultById, edgeResultById } = useSolverResult();
  const numberFormats = useSettings(sfmDoc).numberFormats;
  const fromHandle = useConnection((connection) => connection.fromHandle);
  const node: NodeRecord | undefined = data.record;
  if (!node) return null;

  function isHandleFaded(handleId: string, type: "source" | "target"): boolean {
    if (!fromHandle) return false;
    if (fromHandle.nodeId === id && fromHandle.id === handleId) return false;
    return !isValidDragCandidate(sfmDoc, fromHandle, { nodeId: id, id: handleId, type });
  }

  const allEdges = listEdges(sfmDoc);
  const incoming = allEdges.filter((edge) => edge.toNode === id);
  const outgoing = allEdges.filter((edge) => edge.fromNode === id);
  // Enforced single-item type (`isStorageConnectionAllowed`) — every
  // incident edge already carries the same part, so any one of them names
  // it. `undefined` when nothing is wired up yet.
  const part = incoming[0]?.part ?? outgoing[0]?.part;

  function neighborTitles(): string {
    const inTitles = incoming.map((e) => getNode(sfmDoc, e.fromNode)?.title || e.fromNode);
    const outTitles = outgoing.map((e) => getNode(sfmDoc, e.toNode)?.title || e.toNode);
    return [...inTitles, ...outTitles].join(", ");
  }

  function rateFor(nodeId: string, partName: string): Rational | undefined {
    const rateStr = nodeResultById.get(nodeId)?.partRates[partName];
    return rateStr !== undefined ? parseRational(rateStr) : undefined;
  }

  const isFluid = part ? defaultGameData.partsByName.get(part)?.fluid === true : false;
  const headerIconUrl = getIconUrl(isFluid ? "Fluid Buffer" : "Storage Container");
  const partIconUrl = part ? getIconUrl(part) : undefined;

  const inEdges = incoming.map((e) => ({ edgeId: e.id, part: e.part }));
  const outEdges = outgoing.map((e) => ({ edgeId: e.id, part: e.part }));
  const inRate = part ? rateFor(storageConsumerNodeId(id, part), part) : undefined;
  const outRate = part ? rateFor(storageProducerNodeId(id, part), part) : undefined;
  // `inRate` (the synthetic consumer's own rate) is negative — a
  // consumption. `outRate` (the synthetic producer's own rate) is positive —
  // a supply. Net = how fast the container is FILLING (positive) or
  // DRAINING (negative): intake magnitude minus outflow.
  const net = subtract(inRate ? abs(inRate) : ZERO, outRate ?? ZERO);
  const inValidity = part ? computeNodeValidityState(nodeResultById.get(storageConsumerNodeId(id, part)), inEdges, edgeResultById) : undefined;
  const outValidity = part ? computeNodeValidityState(nodeResultById.get(storageProducerNodeId(id, part)), outEdges, edgeResultById) : undefined;
  const rowSeverity = worseValidity(inValidity?.overall, outValidity?.overall);
  const rowDetail =
    rowSeverity === "mismatched" && part
      ? [computeMismatchDetails(inEdges, edgeResultById)[part], computeMismatchDetails(outEdges, edgeResultById)[part]]
          .filter((d): d is string => !!d)
          .join("; ")
      : undefined;
  const rowTitle =
    rowSeverity === "mismatched"
      ? `Rate mismatch: ${rowDetail || "doesn't match a connected neighbor"}.`
      : rowSeverity === "invalid"
        ? "Connection could not be resolved."
        : part
          ? neighborTitles()
          : "No connections yet — drag a wire to either side.";

  return (
    <div
      className={`relative w-64 rounded-lg border-2 border-[var(--border-strong)] bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors ${
        selected ? "outline outline-2 outline-offset-2 outline-[var(--accent)]" : ""
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5">
        {headerIconUrl ? (
          <img src={headerIconUrl} alt="" className="h-6 w-6 shrink-0 rounded-md bg-black/20 object-contain p-0.5 shadow-inner" />
        ) : (
          <span className="h-6 w-6 shrink-0 rounded-md bg-black/20" aria-hidden />
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--node-header-text)]">
          {node.title || "Storage Container"}
        </p>
      </div>

      <div className={`relative flex items-center gap-1.5 px-2 py-1.5 text-[11px] ${rowRingClass(rowSeverity)}`} title={rowTitle}>
        <Handle
          type="target"
          position={Position.Left}
          id={`in:${WILDCARD_PART}`}
          className={`${handleClass} ${isHandleFaded(`in:${WILDCARD_PART}`, "target") ? handleFadeClass : ""}`}
        />
        {partIconUrl ? (
          <img src={partIconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5" />
        ) : (
          <span className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
          {part ?? "No item — drag a wire to either side"}
        </span>
        {part && (
          <span
            className={`shrink-0 tabular-nums ${
              isZero(net) ? "text-[var(--text-secondary)]" : isNegative(net) ? "text-[var(--danger)]" : "text-[var(--accent)]"
            }`}
          >
            {isNegative(net) ? "-" : "+"}
            {formatRate(net, numberFormats)}/min
          </span>
        )}
        <Handle
          type="source"
          position={Position.Right}
          id={`out:${WILDCARD_PART}`}
          className={`${handleClass} ${isHandleFaded(`out:${WILDCARD_PART}`, "source") ? handleFadeClass : ""}`}
        />
      </div>
    </div>
  );
});
