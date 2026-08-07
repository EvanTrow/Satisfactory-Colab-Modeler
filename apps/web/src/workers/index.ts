// Public surface of Job 018's solver worker host. See PLAN.md §7's
// `apps/web/src/workers/` entry and jobs/018-solver-worker.md's Handoff
// notes for how this fits together. Deliberately does NOT export anything
// from `solverWorker.ts` itself — that file is a Worker entry point,
// instantiated via `new Worker(new URL(...))`, never imported as a normal
// module (see `useSolver.ts`'s `createBrowserWorker`).
export { buildSolverSnapshot, buildSolverSnapshotWithBlueprints } from "./buildSnapshot";
// Job 026: Blueprints (duplicable outposts) — the container-aware compound-
// node collapse/expand pipeline, shared by `buildSnapshot.ts`/`useSolver.ts`
// and `canvas/outposts/BlueprintNode.tsx` (which needs `blueprintCompoundNodeId`
// to look up the copy count by id).
export {
  blueprintCompoundNodeId,
  collapseBlueprints,
  expandBlueprintResults,
  type BlueprintCollapseResult,
  type BlueprintDisplayInfo,
  type MergeComponentResults,
} from "./blueprintCollapse";
export { computeConnectedComponents, type ComponentEdgeLike, type GraphComponent } from "./connectedComponents";
export {
  mergeComponentResults,
  noneResult,
  splitResultByComponents,
  type ComponentResult,
} from "./mergeResults";
export { idCompare, sortedIds } from "./ordering";
export { partitionSnapshot, type SolverComponent } from "./partition";
export type {
  CancelMessage,
  HostToWorkerMessage,
  ProgressMessage,
  SolveErrorMessage,
  SolveRequestMessage,
  SolveResultMessage,
  WorkerLike,
  WorkerToHostMessage,
} from "./protocol";
export {
  createSolveScheduler,
  type SolveHostState,
  type SolveScheduler,
  type SolveSchedulerOptions,
  type SolveStaleness,
} from "./solveScheduler";
export { useSolver, type UseSolverDiagnostics, type UseSolverResult } from "./useSolver";
// Job 024: Splurger node type — pure priority-tier storage + solver-facing
// pass-through rewrite, shared by `buildSnapshot.ts` and
// `canvas/nodes/SplurgerNode.tsx`.
export {
  EMPTY_TIER_ASSIGNMENT,
  computeSplurgerPassthroughEdges,
  computeSplurgerShape,
  decodePriorityOrder,
  encodePriorityOrder,
  moveWithinTier,
  setTier,
  tierForEdge,
  withDefaultedEdges,
  withoutStaleEdges,
  type PassthroughSolverEdge,
  type PriorityTier,
  type SplurgerEdgeLike,
  type SplurgerNodeLike,
  type SplurgerPassthroughResult,
  type SplurgerShape,
  type SplurgerShapeKind,
  type TierAssignment,
} from "./splurgerPassthrough";
