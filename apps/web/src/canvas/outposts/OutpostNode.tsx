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
//
// Calculation-validation visuals pass: an Outpost is never itself a
// `SolverNode` (it's pure navigation/grouping, no recipe/machine of its
// own), so there's no whole-card `.valid`/`.issues` to read the way
// `RecipeNode.tsx` (a REAL compound node) can. What IS
// available: each `DerivedOutpostPort` already carries the real `.edgeId`
// of the one boundary-crossing edge it represents (`portMapping.ts`), so
// each port's own `Handle` can be rung by that edge's own validity via
// `classifyEdgeValidity` — the same function `ConnectionEdge.tsx` uses.
// Known v1 limitation: this only catches a problem AT the boundary (an
// edge actually crossing into/out of this outpost). A problem entirely
// INSIDE the outpost, between two nodes that never cross its boundary,
// stays invisible until the outpost is opened — a full recursive
// descendant rollup is a separate, larger piece of work not attempted here.
import { memo } from "react";

import { parseRational } from "@scm/rational";
import { listEdges } from "@scm/ydoc";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";

import { getIconUrl, getOutpostIconUrl } from "../../assets/icons";
import { useRemotePresence } from "../../collab";
import { useCanvasDoc } from "../CanvasDocContext";
import { classifyEdgeValidity } from "../edges/classifyEdgeValidity";
import { WILDCARD_PART, isValidDragCandidate } from "../edges/connectionLogic";
import { formatRate } from "../formatRate";
import { useSolverResult } from "../SolverResultContext";
import { useSettings } from "../useSettings";
import type { CanvasNode } from "../useYjsSync";
import { computeIoDanglingParts, computeIoNodePorts, computeIoPartRate, outpostInputNodeId, outpostOutputNodeId } from "./io";

/**
 * `"invalid"`/`"mismatched"` -> a ring only (never a `!bg-*` override —
 * `PartRow`'s own `highlightRingClass` in `RecipeNode.tsx` establishes this
 * exact convention: two `!important` background utilities on the same
 * element race on stylesheet insertion order, not class-attribute order, so
 * only ever ADD a ring around a Handle's existing background, never fight
 * over it). `"valid"`/`"unknown"` -> `undefined` (no ring).
 */
function portRingClass(validity: ReturnType<typeof classifyEdgeValidity>): string | undefined {
  if (validity === "invalid") return "ring-2 ring-[var(--danger)]";
  if (validity === "mismatched") return "ring-2 ring-[var(--mismatch)]";
  return undefined;
}

const outpostIconUrl = getOutpostIconUrl();

const inHandleClass = "!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--outpost)]";
const outHandleClass = "!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--outpost)]";
/** Applied to a `Handle` while a connection is being dragged from elsewhere and dropping it here wouldn't be valid — see `RecipeNode.tsx`'s identical `handleFadeClass`. */
const handleFadeClass = "opacity-20 pointer-events-none transition-opacity";

export const OutpostNode = memo(function OutpostNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc, navigateToContainer, awareness } = useCanvasDoc();
  const { edgeResultById, nodeResultById } = useSolverResult();
  const numberFormats = useSettings(sfmDoc).numberFormats;
  // Job 021: same remote-selection halo `RecipeNode.tsx` renders — an
  // outpost boundary node's id IS the container's id, and `selection: []`
  // (Awareness) is a flat list of node/container ids either kind can appear
  // in, so this needs no special-casing beyond reading `id` the normal way.
  const remotePresence = useRemotePresence(awareness);
  const remoteSelectors = remotePresence.filter((peer) => peer.state.selection.includes(id));
  // See `RecipeNode.tsx`'s identical hook for why this is selector-scoped to
  // just `fromHandle`. These boundary handles use a `boundary:<edgeId>:<dir>`
  // id (`portMapping.ts`'s `boundaryPortId`), which `connectionLogic.ts`'s
  // `parsePortHandleId` never parses — meaning they already never validate as
  // a drag target under the existing `isValidConnection` rule, drag or no
  // drag. This just makes that existing fact visible: every one of these
  // dots dims during any connection drag, not only ones started elsewhere on
  // this outpost.
  const fromHandle = useConnection((connection) => connection.fromHandle);
  const container = data.container;
  // Defensive only — `containerToOutpostFlowNode` always sets `data.container` for a `type: "outpost"` node.
  if (!container) return null;

  // Outpost I/O rework: the interactive rows are driven directly
  // by the container's own locked Inputs/Outputs nodes' incident edges
  // (`io.ts`'s `computeIoNodePorts`) — from EITHER side, not just a
  // boundary-crossing one. This is what lets a part show up here as soon as
  // it's wired on ONE side (e.g. an internal producer feeding the Outputs
  // node, nothing external yet) rather than only once both halves happen to
  // be connected — `portMapping.ts`'s `computeOutpostPorts` (still used
  // below for the LEGACY "moved a node into the outpost" rows) can only ever
  // see a genuine boundary crossing, so it stays silent about a part that's
  // only wired on the purely-internal side.
  const allEdges = listEdges(sfmDoc);
  const inputsNodeId = outpostInputNodeId(container.id);
  const outputsNodeId = outpostOutputNodeId(container.id);
  const inRows = computeIoNodePorts(allEdges, inputsNodeId);
  const outRows = computeIoNodePorts(allEdges, outputsNodeId);
  const danglingInParts = computeIoDanglingParts(allEdges, inputsNodeId, "out");
  const danglingOutParts = computeIoDanglingParts(allEdges, outputsNodeId, "in");

  // The legacy "moved a node into the outpost" mechanism never touches
  // these locked nodes at all, so it can't appear in `inRows`/`outRows`
  // above — kept as a separate, read-only, non-interactive row source
  // exactly as before (its ids never start with `${dir}:`, so they never
  // collide with an interactive row's id).
  const legacyPorts = (data.ports ?? []).filter((port) => port.id.startsWith("boundary:"));

  interface Row {
    id: string;
    direction: "in" | "out";
    part: string;
    validity: ReturnType<typeof classifyEdgeValidity>;
    rate: ReturnType<typeof computeIoPartRate>;
    dangling: boolean;
  }

  const VALIDITY_RANK: Record<ReturnType<typeof classifyEdgeValidity>, number> = {
    invalid: 3,
    mismatched: 2,
    unknown: 1,
    valid: 0,
  };

  function worstValidity(edgeIds: readonly string[]): ReturnType<typeof classifyEdgeValidity> {
    return edgeIds
      .map((edgeId) => classifyEdgeValidity(edgeResultById.get(edgeId)))
      .reduce((worst, current) => (VALIDITY_RANK[current] > VALIDITY_RANK[worst] ? current : worst), "valid" as ReturnType<typeof classifyEdgeValidity>);
  }

  const rows: Row[] = [
    ...inRows.map(({ part, edgeIds }) => ({
      id: `in:${part}`,
      direction: "in" as const,
      part,
      validity: worstValidity(edgeIds),
      rate: computeIoPartRate(allEdges, inputsNodeId, part, edgeResultById, nodeResultById),
      dangling: danglingInParts.has(part),
    })),
    ...outRows.map(({ part, edgeIds }) => ({
      id: `out:${part}`,
      direction: "out" as const,
      part,
      validity: worstValidity(edgeIds),
      rate: computeIoPartRate(allEdges, outputsNodeId, part, edgeResultById, nodeResultById),
      dangling: danglingOutParts.has(part),
    })),
    ...legacyPorts.map((port) => {
      const legacyRate = edgeResultById.get(port.edgeId)?.rate;
      return {
        id: port.id,
        direction: port.direction,
        part: port.part,
        validity: classifyEdgeValidity(edgeResultById.get(port.edgeId)),
        rate: legacyRate !== undefined ? parseRational(legacyRate) : null,
        dangling: false,
      };
    }),
  ];

  function isHandleFaded(handleId: string, type: "source" | "target"): boolean {
    if (!fromHandle) return false;
    if (fromHandle.nodeId === id && fromHandle.id === handleId) return false;
    return !isValidDragCandidate(sfmDoc, fromHandle, { nodeId: id, id: handleId, type });
  }

  function open() {
    navigateToContainer(container!.id);
  }

  return (
    <div
      // `nodrag` deliberately *not* applied here — the whole card should
      // still be draggable (its position is the container's own `x`/`y`,
      // per `useYjsSync.ts`'s `onNodeDragStop` branch), same as a normal
      // recipe node.
      className={`w-56 cursor-grab rounded-lg border-2 border-[var(--outpost-border)] bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors active:cursor-grabbing ${
        selected ? "outline outline-2 outline-offset-2 outline-[var(--accent)]" : ""
      }`}
      style={
        remoteSelectors.length > 0
          ? { boxShadow: `0 0 0 3px ${remoteSelectors[0]!.state.color}` }
          : undefined
      }
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
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">Outpost</p>
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
        {rows.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
            No connections yet — drag a wire to either side.
          </p>
        )}
        {rows.map((row) => {
          const ring = portRingClass(row.validity);
          const iconUrl = getIconUrl(row.part);
          return (
            <div
              key={row.id}
              className={`relative flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)] ${row.dangling ? "bg-[var(--danger-soft)]" : ""}`}
              title={
                row.dangling
                  ? `${row.part} needs the other side wired — open this outpost and connect it to a machine.`
                  : row.validity === "invalid"
                    ? "Connection could not be resolved."
                    : row.validity === "mismatched"
                      ? "Rate mismatch on this boundary connection."
                      : undefined
              }
            >
              {row.direction === "in" && (
                <Handle
                  type="target"
                  position={Position.Left}
                  id={row.id}
                  className={`${inHandleClass} ${ring ?? ""} ${isHandleFaded(row.id, "target") ? handleFadeClass : ""}`}
                />
              )}
              {iconUrl ? (
                <img src={iconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5" />
              ) : (
                <span className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                {row.direction === "in" ? "→ " : ""}
                {row.part}
                {row.direction === "out" ? " →" : ""}
              </span>
              {row.rate && (
                <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                  {formatRate(row.rate, numberFormats)}/min
                </span>
              )}
              {row.direction === "out" && (
                <Handle
                  type="source"
                  position={Position.Right}
                  id={row.id}
                  className={`${outHandleClass} ${ring ?? ""} ${isHandleFaded(row.id, "source") ? handleFadeClass : ""}`}
                />
              )}
            </div>
          );
        })}
        {/* Always-present "+" affordances — drag a brand-new item straight onto the card to add it, same wildcard convention `SplurgerNode.tsx` established. */}
        <div className="relative flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--text-muted)]">
          <Handle
            type="target"
            position={Position.Left}
            id={`in:${WILDCARD_PART}`}
            className={`${inHandleClass} ${isHandleFaded(`in:${WILDCARD_PART}`, "target") ? handleFadeClass : ""}`}
          />
          <span className="flex-1 italic">Drag a wire here to add an input or output</span>
          <Handle
            type="source"
            position={Position.Right}
            id={`out:${WILDCARD_PART}`}
            className={`${outHandleClass} ${isHandleFaded(`out:${WILDCARD_PART}`, "source") ? handleFadeClass : ""}`}
          />
        </div>
      </div>
    </div>
  );
});
