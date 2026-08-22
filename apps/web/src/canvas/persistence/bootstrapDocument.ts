// Guest-mode work: the doc-bootstrap logic every hydration path needs
// (create the `SfmDocument`, run the integrity-repair pass, ensure a root
// container exists, create the `Y.UndoManager`) used to live only inline in
// `useProjectDocument.ts`'s `finishHydration`. Extracted here so the new
// local-only guest hook (`useLocalOnlyProjectDocument.ts`) and the read-only
// landing-page sample preview (`landing/SampleFactoryPreview.tsx`) can't
// silently drift from the cloud path — e.g. forgetting the integrity-repair
// pass, or the "only create a root if one doesn't already exist" check that
// stops a reload from minting duplicate roots.
//
// Deliberately does NOT call `captureIntegrityRepairSignal` (Sentry) itself —
// that's a caller decision. `useProjectDocument.ts` still reports a
// non-noop repair for a real project; the guest/sample paths never do, since
// no guest data or telemetry should leave the browser.
import * as Y from "yjs";

import {
  type SfmDocument,
  addContainer,
  createDocument,
  createUndoManager,
  listContainers,
  runIntegrityReducer,
  type IntegrityRepairSummary,
} from "@scm/ydoc";

export interface BootstrappedDocument {
  sfmDoc: SfmDocument;
  rootContainerId: string;
  undoManager: Y.UndoManager;
  /** The repair pass run during bootstrap — callers decide whether a non-noop result is worth reporting (see this file's header comment). */
  initialRepairSummary: IntegrityRepairSummary;
}

/**
 * Turns a raw `Y.Doc` (freshly created, hydrated from IndexedDB, or
 * `Y.applyUpdate`-d from a static snapshot — this function doesn't care
 * which) into everything a `CanvasDocContext` needs. Idempotent on an
 * already-bootstrapped doc: `listContainers` finding an existing root means
 * nothing new is created.
 */
export function bootstrapSfmDocument(doc: Y.Doc): BootstrappedDocument {
  const sfmDoc = createDocument({ doc });

  const initialRepairSummary = runIntegrityReducer(sfmDoc);

  let root = listContainers(sfmDoc).find((container) => container.kind === "root");
  if (!root) {
    root = addContainer(sfmDoc, {
      kind: "root",
      parentId: null,
      title: "Root",
      color: "#4b5563",
      x: 0,
      y: 0,
    });
  }

  // Created last, deliberately — none of the hydration/default-filling
  // mutations above should show up as an undo step once the user starts
  // pressing Ctrl/Cmd+Z (unchanged reasoning from the original inline
  // version in `useProjectDocument.ts`).
  const undoManager = createUndoManager(sfmDoc);

  return { sfmDoc, rootContainerId: root.id, undoManager, initialRepairSummary };
}
