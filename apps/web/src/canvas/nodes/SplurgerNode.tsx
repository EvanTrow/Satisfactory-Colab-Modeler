// Job 024: the Splurger node — PLAN.md's "explicit splitter/merger... two
// priority tiers, top tier drains first, bottom tier takes overflow"
// (Splurger / Priority Splurger / Priority Splitter / Priority Merger,
// treated here as ONE node kind — see jobs/024-priority-nodes.md's Handoff
// notes for why separate node kinds weren't added for the Splitter/Merger
// variants: they're the exact same node, just wired with only one side
// having more than one connection, which is also exactly how real
// Satisfactory splitter/merger hardware works — no piece of hardware has
// multiple inputs AND multiple outputs at once).
//
// Visually distinct from `RecipeNode.tsx` on purpose: no machine/recipe
// icon, no per-part rate readout (a Splurger is never a `SolverNode` — see
// `workers/splurgerPassthrough.ts`'s header — so it has no solver result of
// its own to show), just two generic ports and a list of its own live
// connections with tier/reorder controls. Ports are NOT one-per-recipe-part
// the way `RecipeNode`'s `PartRow`s are (a Splurger has no recipe to derive
// a part list from) — instead there are exactly two `Handle`s, `in:*`/
// `out:*` (`WILDCARD_PART`, `edges/connectionLogic.ts`), each able to carry
// any number of connections of any part; the connection list below is
// derived live from `listEdges(sfmDoc)`, not from a fixed port schema.
import { memo } from "react";

import { getNode, listEdges, removeEdge, setPriorityOrder, type EdgeRecord, type NodeRecord } from "@scm/ydoc";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { WILDCARD_PART } from "../edges/connectionLogic";
import { useCanvasDoc } from "../CanvasDocContext";
import type { CanvasNode } from "../useYjsSync";
import {
  computeSplurgerShape,
  decodePriorityOrder,
  encodePriorityOrder,
  moveWithinTier,
  setTier,
  tierForEdge,
  withDefaultedEdges,
  withoutStaleEdges,
  type PriorityTier,
  type TierAssignment,
} from "../../workers/splurgerPassthrough";

const handleClass = "!h-2.5 !w-2.5 !border-2 !border-[var(--surface-card)] !bg-[var(--splurger)]";

interface ConnectionRow {
  edge: EdgeRecord;
  direction: "in" | "out";
}

/** Which side of `edge` is the Splurger's OWN port — the side whose tier assignment this row edits. For a passthrough/splitter shape that's every output edge; for a merger shape that's every input edge; matches `splurgerPassthrough.ts`'s own "many side owns the tier" rule exactly. */
function tierOwningEdgeId(row: ConnectionRow): string {
  return row.edge.id;
}

function neighborNodeId(row: ConnectionRow): string {
  return row.direction === "in" ? row.edge.fromNode : row.edge.toNode;
}

export const SplurgerNode = memo(function SplurgerNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { sfmDoc } = useCanvasDoc();
  const node: NodeRecord | undefined = data.record;
  if (!node) return null;

  const allEdges = listEdges(sfmDoc);
  const shape = computeSplurgerShape(id, allEdges);
  const rows: ConnectionRow[] = [
    ...shape.inputEdges.map((edge) => ({ edge, direction: "in" as const })),
    ...shape.outputEdges.map((edge) => ({ edge, direction: "out" as const })),
  ].sort((a, b) => a.edge.id.localeCompare(b.edge.id));

  const connectedIds = rows.map((row) => tierOwningEdgeId(row)).sort();
  const assignment: TierAssignment = withDefaultedEdges(
    withoutStaleEdges(decodePriorityOrder(node.priorityOrder), connectedIds),
    connectedIds,
  );

  function persist(next: TierAssignment) {
    setPriorityOrder(sfmDoc, id, encodePriorityOrder(next));
  }

  function neighborTitle(row: ConnectionRow): string {
    const neighborId = neighborNodeId(row);
    return getNode(sfmDoc, neighborId)?.title || neighborId;
  }

  return (
    <div
      className={`relative w-64 rounded-lg border-2 bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)] transition-colors ${
        selected ? "border-[var(--accent)]" : "border-[var(--splurger-border)]"
      }`}
    >
      <div className="flex items-center gap-2 rounded-t-[7px] bg-[var(--node-header)] px-2 py-1.5">
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--splurger)]/90 text-xs font-bold text-[var(--accent-contrast)] shadow-inner"
        >
          ⇄
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--node-header-text)]">{node.title || "Splurger"}</p>
          <p className="truncate text-[10px] text-[var(--node-header-text)]/70">
            {shape.kind === "splitter" && "Priority Splitter"}
            {shape.kind === "merger" && "Priority Merger"}
            {shape.kind === "passthrough" && "Splurger (pass-through)"}
            {shape.kind === "empty" && "Splurger — not wired yet"}
            {shape.kind === "unsupported" && "Splurger"}
          </p>
        </div>
      </div>

      {/*
        Two generic handles, always present, regardless of `shape` — a
        Splurger's own ports are never derived from a recipe part list (it
        has no recipe), so unlike `RecipeNode.tsx`'s per-part `Handle`s these
        don't move/multiply as connections are made. Multiple edges may
        connect to the same handle id; React Flow supports that natively.
      */}
      <Handle type="target" position={Position.Left} id={`in:${WILDCARD_PART}`} className={handleClass} />
      <Handle type="source" position={Position.Right} id={`out:${WILDCARD_PART}`} className={handleClass} />

      {shape.kind === "unsupported" && (
        <p className="mx-2 mt-1.5 rounded-md bg-[var(--danger-soft)] px-2 py-1 text-[10px] text-[var(--danger)]">
          This Splurger has both multiple inputs AND multiple outputs. Real
          splitter/merger hardware never combines both, and Full mode can't
          route flow through this shape — split it into a separate merger
          feeding a separate splitter instead.
        </p>
      )}

      <div className="divide-y divide-[var(--border-subtle)] py-0.5">
        {rows.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
            No connections yet — drag a wire to either side.
          </p>
        ) : (
          rows.map((row) => {
            const edgeId = tierOwningEdgeId(row);
            const tier: PriorityTier = tierForEdge(assignment, edgeId) ?? "top";
            return (
              <div
                key={row.edge.id}
                className="flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-[var(--surface-hover)]"
              >
                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]" title={row.edge.part}>
                  {row.direction === "in" ? "→ " : ""}
                  {row.edge.part}
                  {row.direction === "out" ? " →" : ""}
                  <span className="ml-1 text-[var(--text-muted)]">({neighborTitle(row)})</span>
                </span>
                <button
                  type="button"
                  title={tier === "top" ? "Top tier — drains first" : "Bottom tier — takes overflow"}
                  onClick={() => persist(setTier(assignment, edgeId, tier === "top" ? "bottom" : "top"))}
                  className={`nodrag shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    tier === "top"
                      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "bg-[var(--outpost-soft)] text-[var(--outpost)]"
                  }`}
                >
                  {tier === "top" ? "Top" : "Bottom"}
                </button>
                <button
                  type="button"
                  title="Move up within its tier"
                  onClick={() => persist(moveWithinTier(assignment, edgeId, "up"))}
                  className="nodrag shrink-0 rounded px-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  ↑
                </button>
                <button
                  type="button"
                  title="Move down within its tier"
                  onClick={() => persist(moveWithinTier(assignment, edgeId, "down"))}
                  className="nodrag shrink-0 rounded px-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  ↓
                </button>
                <button
                  type="button"
                  title="Disconnect"
                  onClick={() => removeEdge(sfmDoc, row.edge.id)}
                  className="nodrag shrink-0 rounded px-1 text-[var(--text-muted)] hover:text-[var(--danger)]"
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});
