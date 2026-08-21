// See PLAN.md §7 for this directory's purpose ("panels" = modal/side-panel
// UI, as opposed to `canvas/`'s React Flow plumbing).
export { RecipeChooser, type RecipeChooserProps, type PendingConnectionInfo } from "./RecipeChooser";
// Job 019: summary panel + its pure scope-filtering/aggregation math.
export { SummaryPanel, SUMMARY_SIDEBAR_WIDTH_PX, type SummaryPanelProps } from "./SummaryPanel";
export {
  nodeIdsForScope,
  summarizeScope,
  type CostEntryTotal,
  type ScopedSummary,
  type ScopeInput,
  type SummaryScope,
} from "./summary/summaryMath";
