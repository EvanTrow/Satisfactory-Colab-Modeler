// Serves `resources/images/icons/`'s 204 part/machine PNGs (PLAN.md §1) into
// `apps/web` via Vite's asset pipeline, rather than copying the files into
// `apps/web/public/` or hand-rolling a static-file route.
//
// `resources/` lives at the repo root, *outside* `apps/web/`'s own project
// root (`apps/web/vite.config.ts`'s directory) — Job 003's own Handoff notes
// flagged this as an open caveat for whichever job first needed to actually
// load an icon file through Vite ("Caveat for Jobs 008/009"), and neither of
// those jobs ended up needing to (008 had no node visuals, 009 only ever
// showed recipe/machine *names*, never an icon). This job is the first to
// actually import one.
//
// The good news: nothing extra was needed. Vite's dev-server file-serving
// restriction (`server.fs.allow`) defaults to the *workspace root*, not the
// project root, and it detects the workspace root by walking up from the
// project root looking for a `pnpm-workspace.yaml` (among other markers) —
// see Vite's `searchForWorkspaceRoot`. `pnpm-workspace.yaml` lives at this
// repo's root (`D:\git\Satisfactory-Colab-Modeler`), one level above `apps/`
// itself, so Vite already treats the whole repo (including `resources/`) as
// inside the allowed-to-serve root. Verified empirically in this job's
// manual browser testing (see jobs/010-recipe-node-ui.md's Handoff notes):
// no `vite.config.ts` changes were needed, and every icon `<img>` loads with
// a 200 in both `pnpm dev` and a production `pnpm build`/`preview`.
//
// The actual mechanism: `import.meta.glob` with `query: "?url"` resolves
// every matched file to its final served/bundled URL at *build* time (a
// plain string, eagerly available — no lazy `import()` needed for 204 tiny
// string URLs), exactly like a normal `import x from "./foo.png"` would,
// just for many files via one glob instead of 204 hand-written imports. In
// production this also means every referenced icon gets copied into
// `dist/assets/` with a content hash, same as any other Vite-processed
// asset — no separate copy step to remember.
import { iconFileName } from "@scm/gamedata";

const iconUrlsByPath = import.meta.glob("../../../../resources/images/icons/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const iconUrlByFileName = new Map<string, string>(
  Object.entries(iconUrlsByPath).map(([path, url]) => [path.split("/").pop()!, url]),
);

/**
 * Resolves a part/machine display name (e.g. `"Iron Ore"`, `"Miner Mk.3"`)
 * to its icon's served URL, via `@scm/gamedata`'s `iconFileName`.
 * `undefined` when no matching file was bundled — callers should render a
 * placeholder rather than an empty `<img>` (a stale/unknown machine or part
 * name, e.g. after a `game_data.json` version bump, per PLAN.md §10's
 * "Game-data updates" open question, shouldn't crash the node card).
 */
export function getIconUrl(displayName: string): string | undefined {
  return iconUrlByFileName.get(iconFileName(displayName));
}

// Job 014: `resources/images/custom_icons/` — PLAN.md §1's "icons for the
// three abstract node types" (`Outpost.png`/`Blueprint.png`/`anypart.png`),
// separate from the 204 real part/machine icons above because they don't
// correspond to a `game_data.json` name `iconFileName` can resolve — same
// glob-at-build-time mechanism as `iconUrlsByPath`, just a different source
// directory and a plain filename-keyed map instead of a display-name one.
const customIconUrlsByPath = import.meta.glob("../../../../resources/images/custom_icons/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const customIconUrlByFileName = new Map<string, string>(
  Object.entries(customIconUrlsByPath).map(([path, url]) => [path.split("/").pop()!, url]),
);

/** The outpost card icon (`OutpostNode.tsx`) — real game-art asset instead of an emoji/text placeholder. */
export function getOutpostIconUrl(): string | undefined {
  return customIconUrlByFileName.get("Outpost.png");
}

/** Job 026: the blueprint card icon (`BlueprintNode.tsx`) — same real-game-art convention as `getOutpostIconUrl` above, PLAN.md §1's other "abstract node type" custom icon. */
export function getBlueprintIconUrl(): string | undefined {
  return customIconUrlByFileName.get("Blueprint.png");
}
