// Public API of `@scm/ydoc`. See PLAN.md §4 "The CRDT document schema" and
// §7's "packages/ydoc is the only place that knows the CRDT shape", and
// jobs/007-ydoc-schema.md's Handoff notes for the full picture.
//
// Nothing outside this package should construct or destructure a
// `Y.Map`/`Y.Array` on document content directly — always go through
// `createDocument`'s accessors and `mutations.ts`'s helpers.

export {
  CURRENT_SCHEMA_VERSION,
  ConnectionStyleSchema,
  ContainerKindSchema,
  ContainerSchema,
  EdgeRecordSchema,
  KNOWN_NODE_KINDS,
  LimitModeSchema,
  MetaSchema,
  NodeRecordSchema,
  NumberFormatsSchema,
  NumberFormatStyleSchema,
  PointSchema,
  PuritySchema,
  RoundingModeSchema,
  SettingsSchema,
  SolverModeSchema,
  WaypointSchema,
  type Container,
  type ContainerKind,
  type ConnectionStyle,
  type EdgeRecord,
  type KnownNodeKind,
  type LimitMode,
  type Meta,
  type NodeKind,
  type NodeRecord,
  type NumberFormats,
  type Point,
  type Purity,
  type Settings,
  type SolverMode,
  type Waypoint,
} from "./schema.js";

export {
  createDocument,
  containerToPlain,
  edgeToPlain,
  getContainer,
  getEdge,
  getMeta,
  getNode,
  getSettings,
  listContainers,
  listEdges,
  listEdgesByContainer,
  listNodes,
  listNodesByContainer,
  nodeToPlain,
  snapshotDocument,
  type CreateDocumentOptions,
  type DocumentSnapshot,
  type SfmDocument,
} from "./document.js";

export {
  addContainer,
  addEdge,
  addNode,
  addWaypoint,
  moveNode,
  removeContainer,
  removeEdge,
  removeNode,
  removeWaypoint,
  reparentEdge,
  setPriorityOrder,
  updateContainer,
  updateEdge,
  updateNode,
  updateSettings,
  updateWaypoint,
  type ContainerPatch,
  type EdgePatch,
  type NewContainerInput,
  type NewEdgeInput,
  type NewNodeInput,
  type NodePatch,
  type SettingsPatch,
} from "./mutations.js";

export { computeEdgeId } from "./edgeId.js";

export {
  INTEGRITY_ORIGIN,
  createUndoManager,
  runAsIntegrity,
  type UndoManagerOptions,
} from "./undo.js";

export {
  validateContainer,
  validateDocumentSnapshot,
  validateEdgeRecord,
  validateMeta,
  validateNodeRecord,
  validateSettings,
  type DocumentIssue,
  type DocumentValidationResult,
} from "./validate.js";

export {
  isNoopRepair,
  repairDocument,
  runIntegrityReducer,
  type IntegrityRepairSummary,
} from "./integrity.js";
