// Guest-mode work: public surface of the guest-mode directory. See
// `localProjects.ts` and `GuestModeExplainer.tsx` for the implementations —
// `App.tsx`'s guest-mode wiring is this barrel's only consumer outside the
// directory itself (`GuestProjectsPage.tsx`/`GuestCanvasView.tsx` import
// `localProjects.ts`/`useLocalOnlyProjectDocument.ts` directly, same
// same-directory-imports-direct convention `canvas/index.ts` already uses).
export { GuestModeExplainer } from "./GuestModeExplainer";
export {
  listProjects,
  createProject,
  renameProject,
  duplicateProject,
  deleteProject,
  readGuestProjectDocBytes,
  type GuestProjectSummary,
} from "./localProjects";
export { importGuestProjectsToAccount, type GuestImportSummary } from "./importGuestProjects";
