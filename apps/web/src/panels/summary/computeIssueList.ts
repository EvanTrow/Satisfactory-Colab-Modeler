// The document-wide "everything currently wrong" list behind `SummaryPanel.tsx`'s
// new Issues section. Deliberately does NOT read `SolveResult.warnings` —
// that field (`@scm/solver`'s `result.ts`) is a flattened copy of NODE
// issues only (edge/rate-mismatch issues never make it in) with no id
// attached, so it can't drive a clickable, per-item list. This walks
// `result.nodes`/`result.edges` directly instead, which already carry real
// ids.
//
// Every synthetic id family this app's passthrough workers mint (a Sink's
// per-part consumer, a Storage Container's per-part consumer/producer, a
// Blueprint's compound node) is invisible to this module — it only ever
// sees whatever `resolveNode`/`resolveEdge` can map back to a REAL,
// on-canvas node id. This keeps the id-unwinding (which varies per node
// kind and needs live doc data this module deliberately doesn't touch —
// same "no Yjs" discipline `computeValidity.ts`/`computeMismatchDetails.ts`
// already established) entirely in the caller (`SummaryPanel.tsx`), so this
// stays a small, pure, easily-tested function.
import type { EdgeSolveResult, NodeSolveResult } from "@scm/solver";
import { classifyEdgeValidity } from "../../canvas/edges/classifyEdgeValidity";

export type IssueSeverity = "invalid" | "mismatched" | "unresolved";

export interface IssueEntry {
  /** Stable React list key — also useful for tests, since it encodes exactly which solver entity this came from. */
  readonly key: string;
  readonly severity: IssueSeverity;
  /** Human-readable label for the affected node (or "A → B" for an edge issue). */
  readonly label: string;
  readonly message: string;
  /** Real, on-canvas node id(s) this issue concerns — for "jump to it" navigation. One entry for a node issue, two (from/to) for an edge issue. */
  readonly navigateNodeIds: readonly string[];
}

export interface NodeResolution {
  readonly navigateNodeId: string;
  readonly label: string;
}

export interface EdgeResolution {
  readonly fromNavigateNodeId: string;
  readonly toNavigateNodeId: string;
  readonly fromLabel: string;
  readonly toLabel: string;
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { invalid: 0, mismatched: 1, unresolved: 2 };

/**
 * `resolveNode`/`resolveEdge` return `undefined` for a solver-internal id
 * with no real on-canvas counterpart the caller could map it to — that
 * issue is silently dropped (nothing meaningful to show or navigate to),
 * rather than surfacing a synthetic id a user has never seen.
 */
export function computeIssueList(
  nodes: readonly NodeSolveResult[],
  edges: readonly EdgeSolveResult[],
  resolveNode: (solverNodeId: string) => NodeResolution | undefined,
  resolveEdge: (solverEdgeId: string) => EdgeResolution | undefined,
): IssueEntry[] {
  const entries: IssueEntry[] = [];

  for (const node of nodes) {
    const resolution = resolveNode(node.nodeId);
    if (!resolution) continue;

    if (!node.valid) {
      entries.push({
        key: `node:${node.nodeId}`,
        severity: "invalid",
        label: resolution.label,
        message: node.issues.join("; ") || "This node is invalid.",
        navigateNodeIds: [resolution.navigateNodeId],
      });
    } else if (!node.resolved) {
      entries.push({
        key: `node:${node.nodeId}`,
        severity: "unresolved",
        label: resolution.label,
        message: "No limit set and no resolvable neighbor — defaulted to 1 machine.",
        navigateNodeIds: [resolution.navigateNodeId],
      });
    }
  }

  for (const edge of edges) {
    const severity = classifyEdgeValidity(edge);
    if (severity !== "invalid" && severity !== "mismatched") continue;
    const resolution = resolveEdge(edge.edgeId);
    if (!resolution) continue;

    entries.push({
      key: `edge:${edge.edgeId}`,
      severity,
      label: `${resolution.fromLabel} → ${resolution.toLabel}`,
      message: edge.issues.join("; ") || (severity === "mismatched" ? "Rate mismatch." : "This connection is invalid."),
      navigateNodeIds: [resolution.fromNavigateNodeId, resolution.toNavigateNodeId],
    });
  }

  return entries.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
}
