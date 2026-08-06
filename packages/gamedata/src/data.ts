// Sources `game_data.json` for the rest of the package (and for consumers
// who just want the real data, not a custom fixture).
//
// **Sourcing decision** (the job's open question — see
// jobs/003-gamedata-package.md and this package's Handoff notes): this
// package does NOT copy `resources/game_data/game_data.json` into itself.
// It imports it directly from `resources/` via a relative path, so there is
// exactly one copy of the file on disk — no sync step, no drift risk. This
// works because `tsconfig.base.json` sets `resolveJsonModule: true`, and a
// relative JSON import outside a package's `rootDir` compiles cleanly
// (verified against this exact import with `tsc`) even though `rootDir` is
// `src` — TypeScript's `rootDir` inference doesn't reject JSON module
// imports the way it would a stray `.ts` file outside the root. Both Node
// (Vitest, `tsc`, the Fastify api) and Vite (the web app) resolve relative
// `fs` paths regardless of package/workspace boundaries, so this should work
// unmodified for every consumer — see Handoff notes for the one caveat
// (Vite's dev-server `fs.allow`) later jobs should watch for.
//
// `loadGameData` itself stays pure/synchronous and JSON-import-free (see
// `load.ts`) — this module is the only place that touches `resources/`.
import gameDataJson from "../../../resources/game_data/game_data.json";
import { loadGameData } from "./load";
import type { GameData } from "./types";

/** The real game data, parsed once at module load time. */
export const defaultGameData: GameData = loadGameData(gameDataJson);
