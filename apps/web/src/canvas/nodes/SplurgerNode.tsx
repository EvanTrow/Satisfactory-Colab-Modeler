// Job 024: the Splurger node — PLAN.md's "explicit splitter/merger... two
// priority tiers, top tier drains first, bottom tier takes overflow"
// (Splurger / Priority Splurger / Priority Splitter / Priority Merger).
//
// Redesign pass (user feedback + 4 reference screenshots from the real
// Satisfactory Modeler app): that reference tool locks a FIXED port-slot
// count in at creation time, one of four combinations — plain Splurger
// 1-in/1-out, Priority Splitter 1-in/2-out, Priority Merger 2-in/1-out,
// Priority Splurger 2-in/2-out. `NodeRecord.splurgerVariant` (`@scm/ydoc`'s
// `splurgerPortCaps`) remembers which of the four a given node is;
// `RecipeChooser.tsx`'s four sidebar buttons each set it explicitly. `null`
// (a legacy node from before this field existed) falls back to the most
// permissive case, Priority Splurger's 2/2.
//
// A tiered side (`splurgerPortCaps` cap 2) now renders TWO REAL, independently
// draggable `Handle`s — dropping a wire directly on the top slot makes it
// top-tier, dropping on the bottom slot makes it bottom-tier, matching the
// reference app's own "drag straight to the priority port" interaction. An
// earlier pass tried to keep this to one shared handle plus a manual
// "flip tier" button; that turned out to still read as "only one connection
// point" — real, separate drop targets are what was actually asked for. Each
// tiered handle is its own wildcard SENTINEL (`WILDCARD_PART_TOP`/
// `WILDCARD_PART_BOTTOM`, `edges/connectionLogic.ts` — React Flow requires
// unique ids among same-type handles on one node, so the old shared `"*"`
// id can't just be duplicated), and `EdgeRecord.fromPort`/`.toPort` alone
// then tells you an edge's tier — no `priorityOrder` bookkeeping needed for
// a NEW connection at all. `priorityOrder` is kept only as a fallback for a
// LEGACY edge still on the old plain `"*"` port (pre-dating this pass) —
// see `workers/splurgerPassthrough.ts`'s `tierFromPort` for the solver-side
// mirror of this same fallback. A 1-cap side keeps its single plain-wildcard
// handle unchanged (no tier concept at all there).
//
// This is a real, accepted breaking change for any Splurger wired under the
// previous single-handle scheme on a now-tiered side — its edge's `toPort`/
// `fromPort` is still the old plain `"*"`, which no longer has a matching
// `Handle` DOM element once that side is tiered, so it needs reconnecting.
//
// Still no per-part rate readout on the ports/rows (a Splurger is never a
// `SolverNode` — see `workers/splurgerPassthrough.ts`'s header — its
// incident edges get rewritten with a MINTED id before reaching the solver,
// so there's no `EdgeSolveResult` under the original edge id to show a rate
// from). Flagged as a known, pre-existing gap, not attempted here.
import { ArrowLeftRight, X } from "lucide-react";
import { memo, type ReactNode } from "react";

import {
  getNode,
  listEdges,
  removeEdge,
  splurgerPortCaps,
  type EdgeRecord,
  type NodeRecord,
  type SplurgerPortCaps,
} from "@scm/ydoc";
import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";

import { getIconUrl } from "../../assets/icons";
import {
  WILDCARD_PART,
  WILDCARD_PART_BOTTOM,
  WILDCARD_PART_TOP,
  isValidDragCandidate,
  reconnectEdge,
  type ConnectionLike,
} from "../edges/connectionLogic";
import { useCanvasDoc } from "../CanvasDocContext";
import type { CanvasNode } from "../useYjsSync";
import { decodePriorityOrder, tierForEdge, tierGroupsForCaps, type PriorityTier } from "../../workers/splurgerPassthrough";

const handleClass = "!h-3.5 !w-3.5 !border-2 !border-[var(--surface-card)] !bg-[var(--splurger)]";
/** Applied to a `Handle` while a connection is being dragged from elsewhere and dropping it here wouldn't be valid — see `RecipeNode.tsx`'s identical `handleFadeClass`. */
const handleFadeClass = "opacity-20 pointer-events-none transition-opacity";

const VARIANT_LABELS: Record<string, string> = {
  splurger: "Splurger",
  splitter: "Priority Splitter",
  merger: "Priority Merger",
  prioritySplurger: "Priority Splurger",
};

interface ConnectionRow {
  edge: EdgeRecord;
  direction: "in" | "out";
}

function neighborNodeId(row: ConnectionRow): string {
  return row.direction === "in" ? row.edge.fromNode : row.edge.toNode;
}

/** This row's OWN port on the Splurger side (as opposed to the neighbor's port on the other end). */
function ownPort(row: ConnectionRow): string {
  return row.direction === "in" ? row.edge.toPort : row.edge.fromPort;
}

export const SplurgerNode = memo(function SplurgerNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc } = useCanvasDoc();
  // See `RecipeNode.tsx`'s identical hook for why this is selector-scoped
  // to just `fromHandle`. A Splurger's own handles are wildcards, so they
  // only ever fade while a drag is in progress from another wildcard handle
  // (Splurger-to-Splurger, not a supported connection) or from an
  // unparseable handle id — any real recipe part reconciles against a
  // wildcard freely.
  const fromHandle = useConnection((connection) => connection.fromHandle);
  // Re-bound to an explicitly-typed `const` (rather than relying on
  // flow-narrowing of `data.record` itself) specifically so the narrowing
  // survives into `flipTier` below — same fix `RecipeNode.tsx` applies for
  // the identical reason (a function DECLARATION's body isn't proven to run
  // only synchronously, so TypeScript doesn't carry outer narrowing into it).
  const maybeNode = data.record;
  if (!maybeNode) return null;
  const node: NodeRecord = maybeNode;

  function isHandleFaded(handleId: string, type: "source" | "target"): boolean {
    if (!fromHandle) return false;
    if (fromHandle.nodeId === id && fromHandle.id === handleId) return false;
    return !isValidDragCandidate(fromHandle, { nodeId: id, id: handleId, type });
  }

  const caps: SplurgerPortCaps = splurgerPortCaps(node.splurgerVariant);
  const tierGroups = tierGroupsForCaps(caps);
  const legacyAssignment = decodePriorityOrder(node.priorityOrder);

  /** This row's tier — read straight off its own port when it's one of the new tiered sentinels; falls back to the legacy `priorityOrder` assignment for an old plain-`"*"` edge. */
  function tierOf(row: ConnectionRow): PriorityTier {
    const port = ownPort(row);
    if (port.endsWith(WILDCARD_PART_TOP)) return "top";
    if (port.endsWith(WILDCARD_PART_BOTTOM)) return "bottom";
    return tierForEdge(legacyAssignment, row.edge.id) ?? "top";
  }

  const allEdges = listEdges(sfmDoc);
  const inRows: ConnectionRow[] = allEdges
    .filter((edge) => edge.toNode === id)
    .map((edge) => ({ edge, direction: "in" as const }))
    .sort((a, b) => a.edge.id.localeCompare(b.edge.id));
  const outRows: ConnectionRow[] = allEdges
    .filter((edge) => edge.fromNode === id)
    .map((edge) => ({ edge, direction: "out" as const }))
    .sort((a, b) => a.edge.id.localeCompare(b.edge.id));
  const rows = [...inRows, ...outRows];

  // Parts wired going one way with nothing on the other side at all — the
  // solver has nowhere to route them (see `workers/splurgerPassthrough.ts`'s
  // header); surfaced as a warning rather than silently dropped.
  const inParts = new Set(inRows.map((row) => row.edge.part));
  const outParts = new Set(outRows.map((row) => row.edge.part));
  const danglingParts = [...new Set([...inParts, ...outParts])].filter(
    (part) => inParts.has(part) !== outParts.has(part),
  );
  const unsupported = inRows.length > 1 && outRows.length > 1;

  const inTop = inRows.filter((row) => tierOf(row) === "top");
  const inBottom = inRows.filter((row) => tierOf(row) === "bottom");
  const outTop = outRows.filter((row) => tierOf(row) === "top");
  const outBottom = outRows.filter((row) => tierOf(row) === "bottom");

  function neighborTitle(row: ConnectionRow): string {
    const neighborId = neighborNodeId(row);
    return getNode(sfmDoc, neighborId)?.title || neighborId;
  }

  /** Reconnects `row` to the OTHER tier's handle — same neighbor/part, this Splurger's own port swapped to the other sentinel. Only ever called for a tiered side (2-cap), so both sentinels are always real, rendered handles. */
  function flipTier(row: ConnectionRow) {
    const nextSentinel = tierOf(row) === "top" ? WILDCARD_PART_BOTTOM : WILDCARD_PART_TOP;
    const nextOwnPort = `${row.direction}:${nextSentinel}`;
    const connection: ConnectionLike =
      row.direction === "in"
        ? { source: row.edge.fromNode, sourceHandle: row.edge.fromPort, target: id, targetHandle: nextOwnPort }
        : { source: id, sourceHandle: nextOwnPort, target: row.edge.toNode, targetHandle: row.edge.toPort };
    reconnectEdge(sfmDoc, node.containerId, row.edge.id, connection, row.edge.waypoints);
  }

  const variantLabel = node.splurgerVariant ? VARIANT_LABELS[node.splurgerVariant] : VARIANT_LABELS.prioritySplurger;

  return (
    <div
      className={`relative w-64 rounded-lg border-2 bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors ${
        selected ? "border-[var(--accent)]" : "border-[var(--splurger-border)]"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5">
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--splurger)]/90 text-[var(--accent-contrast)] shadow-inner"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--node-header-text)]">{node.title || variantLabel}</p>
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">{variantLabel}</p>
        </div>
      </div>

      {/*
        Ports band: one `PortSlot` per handle — 1 or 2 per side, per `caps` —
        flanking a central machine icon, matching the reference app's card
        art. Each slot hosts its OWN real `Handle`, so a tiered side has two
        genuinely independent drop targets (see this file's header).
      */}
      <div className="flex items-center justify-between gap-1.5 px-3 py-3">
        <div className="flex flex-col gap-1.5">
          {caps.in === 2 ? (
            <>
              <PortSlot
                rows={inTop}
                emptyLabel="Top input — nothing connected yet"
                handleType="target"
                handlePosition={Position.Left}
                handleId={`in:${WILDCARD_PART_TOP}`}
                isFaded={isHandleFaded(`in:${WILDCARD_PART_TOP}`, "target")}
              />
              <PortSlot
                rows={inBottom}
                emptyLabel="Bottom input — nothing connected yet"
                handleType="target"
                handlePosition={Position.Left}
                handleId={`in:${WILDCARD_PART_BOTTOM}`}
                isFaded={isHandleFaded(`in:${WILDCARD_PART_BOTTOM}`, "target")}
              />
            </>
          ) : (
            <PortSlot
              rows={inRows}
              emptyLabel="Input — nothing connected yet"
              handleType="target"
              handlePosition={Position.Left}
              handleId={`in:${WILDCARD_PART}`}
              isFaded={isHandleFaded(`in:${WILDCARD_PART}`, "target")}
            />
          )}
        </div>
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--splurger)]/20 text-[var(--splurger)]"
        >
          <ArrowLeftRight className="h-5 w-5" aria-hidden />
        </span>
        <div className="flex flex-col gap-1.5">
          {caps.out === 2 ? (
            <>
              <PortSlot
                rows={outTop}
                emptyLabel="Top output — nothing connected yet"
                handleType="source"
                handlePosition={Position.Right}
                handleId={`out:${WILDCARD_PART_TOP}`}
                isFaded={isHandleFaded(`out:${WILDCARD_PART_TOP}`, "source")}
              />
              <PortSlot
                rows={outBottom}
                emptyLabel="Bottom output — nothing connected yet"
                handleType="source"
                handlePosition={Position.Right}
                handleId={`out:${WILDCARD_PART_BOTTOM}`}
                isFaded={isHandleFaded(`out:${WILDCARD_PART_BOTTOM}`, "source")}
              />
            </>
          ) : (
            <PortSlot
              rows={outRows}
              emptyLabel="Output — nothing connected yet"
              handleType="source"
              handlePosition={Position.Right}
              handleId={`out:${WILDCARD_PART}`}
              isFaded={isHandleFaded(`out:${WILDCARD_PART}`, "source")}
            />
          )}
        </div>
      </div>

      {unsupported && (
        <p className="mx-2 mt-1.5 rounded-md bg-[var(--danger-soft)] px-2 py-1 text-[10px] text-[var(--danger)]">
          This Splurger has both multiple inputs AND multiple outputs. Real
          splitter/merger hardware never combines both, and Full mode can't
          route flow through this shape — split it into a separate merger
          feeding a separate splitter instead.
        </p>
      )}

      {danglingParts.length > 0 && (
        <p className="mx-2 mt-1.5 rounded-md bg-[var(--danger-soft)] px-2 py-1 text-[10px] text-[var(--danger)]">
          {danglingParts.join(", ")} {danglingParts.length === 1 ? "is" : "are"} wired on only one side —
          nothing to route {danglingParts.length === 1 ? "it" : "them"} to, so this flow is being dropped
          from the solve.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
          No connections yet — drag a wire to either side.
        </p>
      ) : (
        <div className="py-0.5">
          <PortSide
            rows={inRows}
            tiered={tierGroups.in}
            top={inTop}
            bottom={inBottom}
            danglingParts={danglingParts}
            neighborTitle={neighborTitle}
            onDisconnect={(row) => removeEdge(sfmDoc, row.edge.id)}
            onFlipTier={flipTier}
          />
          <PortSide
            rows={outRows}
            tiered={tierGroups.out}
            top={outTop}
            bottom={outBottom}
            danglingParts={danglingParts}
            neighborTitle={neighborTitle}
            onDisconnect={(row) => removeEdge(sfmDoc, row.edge.id)}
            onFlipTier={flipTier}
          />
        </div>
      )}
    </div>
  );
});

interface PortSlotProps {
  rows: readonly ConnectionRow[];
  emptyLabel: string;
  handleType: "source" | "target";
  handlePosition: Position;
  handleId: string;
  isFaded: boolean;
}

/**
 * One icon-box port slot in the ports band, hosting its own real `Handle` —
 * `relative` so the `Handle` (an absolutely-positioned child, same pattern
 * `RecipeNode.tsx`'s `PartRow` uses for its own per-row handles) anchors to
 * THIS slot specifically, not the whole card.
 */
function PortSlot({ rows, emptyLabel, handleType, handlePosition, handleId, isFaded }: PortSlotProps) {
  const distinctParts = [...new Set(rows.map((row) => row.edge.part))];
  return (
    <div className="relative flex h-8 w-8 items-center justify-center">
      {distinctParts.length === 0 ? (
        <div
          className="flex h-8 w-8 items-center justify-center rounded border border-dashed border-[var(--border-subtle)] text-[var(--text-muted)]"
          title={emptyLabel}
          aria-hidden
        >
          <span className="h-3 w-3 rounded-full border border-current" />
        </div>
      ) : (
        <div
          className="relative flex h-8 w-8 items-center justify-center rounded border border-[var(--splurger-border)] bg-[var(--surface-sunken)]"
          title={distinctParts.join(", ")}
        >
          {getIconUrl(distinctParts[0]!) ? (
            <img src={getIconUrl(distinctParts[0]!)} alt="" className="h-6 w-6 object-contain" />
          ) : (
            <span className="h-5 w-5 rounded-sm bg-[var(--surface-hover)]" aria-hidden />
          )}
          {distinctParts.length > 1 && (
            <span className="absolute -right-1 -top-1 rounded-full bg-[var(--splurger)] px-1 text-[9px] font-medium text-[var(--accent-contrast)]">
              +{distinctParts.length - 1}
            </span>
          )}
        </div>
      )}
      <Handle
        type={handleType}
        position={handlePosition}
        id={handleId}
        className={`${handleClass} ${isFaded ? handleFadeClass : ""}`}
      />
    </div>
  );
}

interface PortSideProps {
  rows: readonly ConnectionRow[];
  tiered: boolean;
  top: readonly ConnectionRow[];
  bottom: readonly ConnectionRow[];
  danglingParts: readonly string[];
  neighborTitle: (row: ConnectionRow) => string;
  onDisconnect: (row: ConnectionRow) => void;
  onFlipTier: (row: ConnectionRow) => void;
}

/** One direction's (in/out) detail list — either two `TierGroup`s (this side's `splurgerPortCaps` cap is 2) or one flat list (cap is 1, so no tier is meaningful here). */
function PortSide({ rows, tiered, top, bottom, danglingParts, neighborTitle, onDisconnect, onFlipTier }: PortSideProps) {
  if (rows.length === 0) return null;
  if (!tiered) {
    return (
      <div className="divide-y divide-[var(--border-subtle)]">
        {rows.map((row) => (
          <ConnectionRowView
            key={row.edge.id}
            row={row}
            isDangling={danglingParts.includes(row.edge.part)}
            neighborTitle={neighborTitle(row)}
            onDisconnect={() => onDisconnect(row)}
          />
        ))}
      </div>
    );
  }
  return (
    <>
      {top.length > 0 && (
        <TierGroup label="Top — priority" accentClassName="text-[var(--accent)]">
          {top.map((row) => (
            <ConnectionRowView
              key={row.edge.id}
              row={row}
              isDangling={danglingParts.includes(row.edge.part)}
              neighborTitle={neighborTitle(row)}
              onDisconnect={() => onDisconnect(row)}
              onFlipTier={() => onFlipTier(row)}
            />
          ))}
        </TierGroup>
      )}
      {bottom.length > 0 && (
        <TierGroup label="Bottom — overflow" accentClassName="text-[var(--outpost)]">
          {bottom.map((row) => (
            <ConnectionRowView
              key={row.edge.id}
              row={row}
              isDangling={danglingParts.includes(row.edge.part)}
              neighborTitle={neighborTitle(row)}
              onDisconnect={() => onDisconnect(row)}
              onFlipTier={() => onFlipTier(row)}
            />
          ))}
        </TierGroup>
      )}
    </>
  );
}

interface TierGroupProps {
  label: string;
  accentClassName: string;
  children: ReactNode;
}

/** One "Top — priority" / "Bottom — overflow" section — only rendered on a side whose `splurgerPortCaps` cap is 2. */
function TierGroup({ label, accentClassName, children }: TierGroupProps) {
  return (
    <div className="border-t border-[var(--border-subtle)]">
      <p className={`px-2 pt-1 text-[10px] font-medium uppercase tracking-wide ${accentClassName}`}>{label}</p>
      <div className="divide-y divide-[var(--border-subtle)]">{children}</div>
    </div>
  );
}

interface ConnectionRowViewProps {
  row: ConnectionRow;
  isDangling: boolean;
  neighborTitle: string;
  onDisconnect: () => void;
  /** Present only for a row inside a `TierGroup` — reconnects it to the OTHER tier's handle. Absent for a non-tiered side. */
  onFlipTier?: () => void;
}

/** One connection row — part icon (same `getIconUrl` convention `RecipeNode.tsx`'s `PartRow` uses), neighbor name, and its available actions. */
function ConnectionRowView({ row, isDangling, neighborTitle, onDisconnect, onFlipTier }: ConnectionRowViewProps) {
  const iconUrl = getIconUrl(row.edge.part);
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)] ${
        isDangling ? "bg-[var(--danger-soft)]" : ""
      }`}
      title={isDangling ? `${row.edge.part} has nothing on the other side — not routed` : undefined}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)] object-contain p-0.5" />
      ) : (
        <span className="h-4 w-4 shrink-0 rounded-sm bg-[var(--surface-sunken)]" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
        {row.edge.part}
        <span className="ml-1 text-[var(--text-muted)]">({neighborTitle})</span>
      </span>
      {onFlipTier && (
        <button
          type="button"
          title="Move to the other tier"
          aria-label={`Move ${row.edge.part} connection to the other tier`}
          onClick={onFlipTier}
          className="nodrag shrink-0 rounded px-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <ArrowLeftRight className="h-3 w-3 rotate-90" aria-hidden />
        </button>
      )}
      <button
        type="button"
        title="Disconnect"
        aria-label={`Disconnect ${row.edge.part} connection`}
        onClick={onDisconnect}
        className="nodrag shrink-0 rounded px-1 text-[var(--text-muted)] hover:text-[var(--danger)]"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
