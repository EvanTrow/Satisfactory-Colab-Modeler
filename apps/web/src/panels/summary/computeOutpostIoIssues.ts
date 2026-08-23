// Calculation-validation visuals pass, outpost follow-up: `OutpostIoNode.tsx`
// already shows a dangling-part/unsupported-part warning banner locally on
// the Inputs/Outputs card itself (`io.ts`'s `computeIoDanglingParts`/
// `computeIoUnsupportedParts`), but the document-wide Issues list in
// `SummaryPanel.tsx` never sees it: an outpost's Inputs/Outputs node is
// never erased into a `SolverNode` at all (same as a Splurger — see
// `splurgerPassthrough.ts`'s own header), so `computeIssueList.ts`'s
// solver-result-only walk has nothing to find. This is a second, deliberately
// separate source for `SummaryPanel.tsx`'s Issues list — a document-level
// check over real `NodeRecord`/`EdgeRecord`s instead of solve output — merged
// in by the caller via `computeIssueList.ts`'s `sortIssueEntries`.
import type { EdgeRecord, NodeRecord } from "@scm/ydoc";

import {
  OUTPOST_OUTPUT_KIND,
  computeIoDanglingParts,
  computeIoUnsupportedParts,
  isOutpostIoKind,
} from "../../canvas/outposts/io";
import type { IssueEntry } from "./computeIssueList";

/**
 * One entry per outpost Inputs/Outputs node that currently has a dangling
 * and/or unsupported part, combining both warnings into a single message —
 * mirrors `OutpostIoNode.tsx`'s own two-banner text exactly, just flattened
 * into one row since the Issues list is one-entry-per-entity, not
 * one-entry-per-part. Both conditions render with `--danger` styling on the
 * node itself, so both are reported here as `"invalid"` severity.
 */
export function computeOutpostIoIssues(
  allNodes: readonly NodeRecord[],
  allEdges: readonly EdgeRecord[],
  nodeDisplayName: (node: NodeRecord) => string,
): IssueEntry[] {
  const entries: IssueEntry[] = [];

  for (const node of allNodes) {
    if (!isOutpostIoKind(node.kind)) continue;
    const internalDirection: "in" | "out" = node.kind === OUTPOST_OUTPUT_KIND ? "in" : "out";
    const dangling = [...computeIoDanglingParts(allEdges, node.id, internalDirection)];
    const unsupported = [...computeIoUnsupportedParts(allEdges, node.id, internalDirection)];
    if (dangling.length === 0 && unsupported.length === 0) continue;

    const messages: string[] = [];
    if (unsupported.length > 0) {
      messages.push(
        `${unsupported.join(", ")}: multiple sources and multiple destinations for the same item isn't supported here.`,
      );
    }
    if (dangling.length > 0) {
      messages.push(`${dangling.join(", ")} wired on only one side — connect the other side or remove it.`);
    }

    entries.push({
      key: `outpost-io:${node.id}`,
      severity: "invalid",
      label: nodeDisplayName(node),
      message: messages.join(" "),
      navigateNodeIds: [node.id],
    });
  }

  return entries;
}
