// Guest-mode work: migrates every guest project in this browser into the
// signed-in user's real cloud account — "sign in from guest mode and your
// guest projects get added to your account, even if you already have
// projects there" per this feature's own requirement. Runs from `App.tsx`
// once `auth.status` flips to `"authenticated"` while the guest-mode flag
// is still set (see that file's own effect for the full trigger condition).
//
// Each guest project is imported independently: read its real content
// (`readGuestProjectDocBytes`), create a brand-new cloud project for it
// (`createProject` — always adds a new project, never reuses/merges into
// an existing one, regardless of how many the account already has), seed
// that new project's doc with the guest content (`pushInitialDocUpdate`),
// then — only once all of that has actually succeeded — delete the local
// guest copy. A project that fails partway (a dropped request, a 5xx)
// simply stays in this browser's guest list untouched, so a later retry
// (the next time `App.tsx`'s effect runs, e.g. a page reload while still
// signed in) picks it back up instead of silently losing or double-adding
// it.
import { createProject, type ProjectSummary } from "../api/projects";
import { pushInitialDocUpdate } from "../canvas";
import { deleteProject as deleteGuestProject, listProjects as listGuestProjects, readGuestProjectDocBytes } from "./localProjects";

export interface GuestImportSummary {
  imported: number;
  failed: number;
}

export async function importGuestProjectsToAccount(): Promise<GuestImportSummary> {
  const guestProjects = await listGuestProjects();
  let imported = 0;
  let failed = 0;

  for (const guestProject of guestProjects) {
    try {
      const bytes = await readGuestProjectDocBytes(guestProject.id);
      const cloudProject: ProjectSummary = await createProject(guestProject.title);
      await pushInitialDocUpdate(cloudProject.id, bytes);
      await deleteGuestProject(guestProject.id);
      imported++;
    } catch (err) {
      failed++;
      console.error(`[importGuestProjects] failed to import guest project ${guestProject.id}`, err);
    }
  }

  return { imported, failed };
}
