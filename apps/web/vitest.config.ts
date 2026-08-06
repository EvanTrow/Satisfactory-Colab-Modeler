// Minimal Vitest config for `apps/web`'s first automated tests (Job 009's
// Recipe Chooser filter/variant-resolution logic — see
// `src/panels/recipeChooser/filters.test.ts`). Deliberately does not reuse
// `vite.config.ts`'s React/Tailwind plugins: everything under test so far is
// plain TypeScript (no JSX, no CSS imports), so a plugin-free Node
// environment is enough and keeps `pnpm --filter web test` fast. If a later
// job adds component-level tests, this config is the place to add
// `@vitejs/plugin-react` and a `jsdom`/`happy-dom` environment.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
