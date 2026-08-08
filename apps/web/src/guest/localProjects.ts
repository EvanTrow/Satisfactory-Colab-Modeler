// Guest-mode work: purely local project storage — mirrors `api/projects.ts`'s
// function names/shapes (`listProjects`/`createProject`/`renameProject`/
// `duplicateProject`/`deleteProject`) so `GuestProjectsPage.tsx` can reuse
// the exact same interaction patterns `ProjectsPage.tsx` already
// established, but backed by a `localStorage` index plus one IndexedDB
// database per project (`useLocalOnlyProjectDocument.ts` opens the same
// name lazily when a guest project is actually opened) instead of a REST
// API. No network call anywhere in this file — every guest project stays in
// this browser, per the app's Limited Guest Mode promise.
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

import { deleteLocalOnlyProjectDocument, guestIndexedDbName } from "../canvas/persistence/useLocalOnlyProjectDocument";

const INDEX_STORAGE_KEY = "scm-guest-projects";

/** Mirrors the server's own default (`apps/api/src/projects/store.ts`'s `DEFAULT_TITLE`) so a guest and an authenticated user see identical default naming. */
const DEFAULT_TITLE = "My Factory";

export interface GuestProjectSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

function readIndex(): GuestProjectSummary[] {
  try {
    const raw = localStorage.getItem(INDEX_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GuestProjectSummary[]) : [];
  } catch {
    // Corrupt/foreign JSON in this key — treat as "no guest projects yet"
    // rather than throwing, same "never let a local-storage read crash the
    // app" posture `theme/useTheme.ts`/`i18n/i18n.ts` already take.
    return [];
  }
}

function writeIndex(projects: GuestProjectSummary[]): void {
  localStorage.setItem(INDEX_STORAGE_KEY, JSON.stringify(projects));
}

function findOrThrow(id: string): GuestProjectSummary {
  const project = readIndex().find((p) => p.id === id);
  if (!project) throw new Error(`Guest project ${id} not found`);
  return project;
}

/**
 * Opens a guest project's IndexedDB database just long enough to read its
 * full current state as one Yjs update, then closes it again — the shared
 * "read this guest project's real content" primitive behind both
 * `duplicateProject` below and `importGuestProjects.ts`'s account-import
 * flow. Read-only: never mutates the source database.
 */
export async function readGuestProjectDocBytes(id: string): Promise<Uint8Array> {
  const doc = new Y.Doc();
  const idb = new IndexeddbPersistence(guestIndexedDbName(id), doc);
  await idb.whenSynced;
  const update = Y.encodeStateAsUpdate(doc);
  await idb.destroy();
  return update;
}

export function listProjects(): Promise<GuestProjectSummary[]> {
  return Promise.resolve(readIndex().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
}

export function createProject(title?: string): Promise<GuestProjectSummary> {
  const now = new Date().toISOString();
  const project: GuestProjectSummary = {
    id: crypto.randomUUID(),
    title: title?.trim() || DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
  };
  // The project's own IndexedDB database isn't created here — it's opened
  // lazily the first time `GuestCanvasView` actually mounts it
  // (`useLocalOnlyProjectDocument`'s `bootstrapSfmDocument` call creates the
  // root container on that first open), same "doc created on first real
  // open, not at row-creation time" shape `useProjectDocument.ts` already
  // has for a brand-new cloud project.
  writeIndex([project, ...readIndex()]);
  return Promise.resolve(project);
}

export function renameProject(id: string, title: string): Promise<GuestProjectSummary> {
  const projects = readIndex();
  const index = projects.findIndex((p) => p.id === id);
  if (index === -1) return Promise.reject(new Error(`Guest project ${id} not found`));
  const updated: GuestProjectSummary = { ...projects[index]!, title, updatedAt: new Date().toISOString() };
  projects[index] = updated;
  writeIndex(projects);
  return Promise.resolve(updated);
}

/**
 * Copies both the index entry and the actual canvas content: opens the
 * source project's IndexedDB database, reads its full state as one Yjs
 * update, and applies that into a brand-new database under a fresh id — the
 * same "duplication includes real content, not just settings" behavior
 * `apps/api/src/projects/store.ts`'s own `duplicateProject` has server-side.
 */
export async function duplicateProject(id: string): Promise<GuestProjectSummary> {
  const source = findOrThrow(id);
  const update = await readGuestProjectDocBytes(id);

  const now = new Date().toISOString();
  const copy: GuestProjectSummary = {
    id: crypto.randomUUID(),
    title: source.title,
    createdAt: now,
    updatedAt: now,
  };

  // Open the target's (empty) database FIRST, then apply the update — in
  // that order, `IndexeddbPersistence`'s own `doc.on('update', ...)`
  // listener (attached in its constructor) is already watching by the time
  // `Y.applyUpdate` fires the `update` event, so it persists what it just
  // captured. Doing this in the opposite order would apply the update
  // before anything was listening for it, and none of it would ever reach
  // IndexedDB.
  const targetDoc = new Y.Doc();
  const targetIdb = new IndexeddbPersistence(guestIndexedDbName(copy.id), targetDoc);
  await targetIdb.whenSynced;
  Y.applyUpdate(targetDoc, update);
  await targetIdb.destroy();

  writeIndex([copy, ...readIndex()]);
  return copy;
}

export async function deleteProject(id: string): Promise<void> {
  writeIndex(readIndex().filter((p) => p.id !== id));
  await deleteLocalOnlyProjectDocument(id);
}
