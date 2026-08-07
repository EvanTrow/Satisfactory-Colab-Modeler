// `createDocument()` — the typed wrapper around a raw `Y.Doc` that gives
// every other part of the app (canvas, persistence, integrity reducer,
// realtime server) a single place to read/write the CRDT shape from
// PLAN.md §4. Nothing outside `packages/ydoc` should construct or
// destructure a `Y.Map`/`Y.Array` on doc content directly — go through the
// accessors here (or the mutation helpers in `mutations.ts`) instead.
import * as Y from "yjs";
import {
  type Container,
  type EdgeRecord,
  type Meta,
  type NodeRecord,
  type Settings,
  CURRENT_SCHEMA_VERSION,
} from "./schema.js";

/**
 * A `Y.Doc` with the five top-level maps from PLAN.md §4 already created,
 * plus typed read accessors. The raw `Y.Doc` and top-level `Y.Map`
 * instances are exposed deliberately — Job 008's Zustand store needs to
 * call Yjs's own `.observe()`/`.observeDeep()` on `containers`/`nodes`/
 * `edges` to react to remote/local changes, and a persistence provider
 * (Jobs 015/016/020) needs the raw `doc` to attach to. What callers must
 * *not* do is reach into a `Y.Map` entry's fields by hand — use
 * `getNode`/`getEdge`/`getContainer` (or the `*ToPlain` converters below)
 * to turn a `Y.Map` into a typed plain object instead.
 */
export interface SfmDocument {
  readonly doc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly settings: Y.Map<unknown>;
  readonly containers: Y.Map<Y.Map<unknown>>;
  readonly nodes: Y.Map<Y.Map<unknown>>;
  readonly edges: Y.Map<Y.Map<unknown>>;
}

export interface CreateDocumentOptions {
  /** Wrap an existing `Y.Doc` instead of creating a new one (e.g. after `Y.applyUpdate`). */
  doc?: Y.Doc;
  /** Only applied when the `meta` map is empty (i.e. a brand-new document). */
  meta?: Partial<Meta>;
  settings?: Partial<Settings>;
}

const DEFAULT_META: Meta = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  title: "My Factory",
  gameDataVersion: "",
};

const DEFAULT_SETTINGS: Settings = {
  solverMode: "full",
  inputMultiplier: 1,
  powerMultiplier: 1,
  spaceElevatorMultiplier: 1,
  snapMachines: false,
  gridMachine: { x: 100, y: 100 },
  snapWaypoints: false,
  gridWaypoint: { x: 50, y: 50 },
  numberFormats: {
    style: "decimal",
    digits: 2,
    rounding: "round",
    trimTrailingZeros: true,
  },
  connectionStyle: "bezier",
};

function setPlainFields(map: Y.Map<unknown>, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    map.set(key, value);
  }
}

/**
 * Creates (or wraps) the `Y.Doc` with `meta`/`settings`/`containers`/
 * `nodes`/`edges` present at their PLAN.md §4 keys. Safe to call on an
 * already-populated doc (e.g. one just hydrated from a persisted update) —
 * defaults are only written into `meta`/`settings` when those maps are
 * still empty, so it never clobbers existing content.
 */
export function createDocument(options: CreateDocumentOptions = {}): SfmDocument {
  const doc = options.doc ?? new Y.Doc();

  const meta = doc.getMap<unknown>("meta");
  const settings = doc.getMap<unknown>("settings");
  const containers = doc.getMap<Y.Map<unknown>>("containers");
  const nodes = doc.getMap<Y.Map<unknown>>("nodes");
  const edges = doc.getMap<Y.Map<unknown>>("edges");

  if (meta.size === 0) {
    doc.transact(() => {
      setPlainFields(meta, { ...DEFAULT_META, ...options.meta });
    });
  }
  if (settings.size === 0) {
    doc.transact(() => {
      setPlainFields(settings, { ...DEFAULT_SETTINGS, ...options.settings });
    });
  }

  return { doc, meta, settings, containers, nodes, edges };
}

// ---------------------------------------------------------------------------
// Typed reads
// ---------------------------------------------------------------------------

export function getMeta(sfmDoc: SfmDocument): Meta {
  return sfmDoc.meta.toJSON() as Meta;
}

export function getSettings(sfmDoc: SfmDocument): Settings {
  return sfmDoc.settings.toJSON() as Settings;
}

/** Converts a container's raw `Y.Map` (e.g. from an observe callback) into a typed plain object. */
export function containerToPlain(map: Y.Map<unknown>): Container {
  return map.toJSON() as Container;
}

export function getContainer(sfmDoc: SfmDocument, containerId: string): Container | undefined {
  const map = sfmDoc.containers.get(containerId);
  return map ? containerToPlain(map) : undefined;
}

export function listContainers(sfmDoc: SfmDocument): Container[] {
  return Array.from(sfmDoc.containers.values(), containerToPlain);
}

/** Converts a node's raw `Y.Map` (e.g. from an observe callback) into a typed plain object. */
export function nodeToPlain(map: Y.Map<unknown>): NodeRecord {
  const json = map.toJSON() as Record<string, unknown>;
  return {
    ...json,
    priorityOrder: Array.isArray(json.priorityOrder) ? json.priorityOrder : [],
  } as NodeRecord;
}

export function getNode(sfmDoc: SfmDocument, nodeId: string): NodeRecord | undefined {
  const map = sfmDoc.nodes.get(nodeId);
  return map ? nodeToPlain(map) : undefined;
}

export function listNodes(sfmDoc: SfmDocument): NodeRecord[] {
  return Array.from(sfmDoc.nodes.values(), nodeToPlain);
}

export function listNodesByContainer(sfmDoc: SfmDocument, containerId: string): NodeRecord[] {
  return listNodes(sfmDoc).filter((node) => node.containerId === containerId);
}

/** Converts an edge's raw `Y.Map` (e.g. from an observe callback) into a typed plain object. */
export function edgeToPlain(map: Y.Map<unknown>): EdgeRecord {
  const json = map.toJSON() as Record<string, unknown>;
  return {
    ...json,
    waypoints: Array.isArray(json.waypoints) ? json.waypoints : [],
  } as EdgeRecord;
}

export function getEdge(sfmDoc: SfmDocument, edgeId: string): EdgeRecord | undefined {
  const map = sfmDoc.edges.get(edgeId);
  return map ? edgeToPlain(map) : undefined;
}

export function listEdges(sfmDoc: SfmDocument): EdgeRecord[] {
  return Array.from(sfmDoc.edges.values(), edgeToPlain);
}

export function listEdgesByContainer(sfmDoc: SfmDocument, containerId: string): EdgeRecord[] {
  return listEdges(sfmDoc).filter((edge) => edge.containerId === containerId);
}

/** A fully-materialized plain-object snapshot of the whole document. Used by `validate.ts` and tests. */
export interface DocumentSnapshot {
  meta: Meta;
  settings: Settings;
  containers: Container[];
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

export function snapshotDocument(sfmDoc: SfmDocument): DocumentSnapshot {
  return {
    meta: getMeta(sfmDoc),
    settings: getSettings(sfmDoc),
    containers: listContainers(sfmDoc),
    nodes: listNodes(sfmDoc),
    edges: listEdges(sfmDoc),
  };
}
