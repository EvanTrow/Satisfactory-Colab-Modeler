import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Proxies auth requests to apps/api (default port 3001) so the
      // browser sees everything as same-origin on 5173 — required for the
      // sfm_session cookie's flow and matching PLAN.md §9's verification
      // bullet, which registers the Discord callback at
      // http://localhost:5173/auth/discord/callback.
      "/auth": "http://localhost:3001",
      // Job 006's project CRUD routes (apps/api/src/projects/routes.ts),
      // same same-origin-cookie reasoning as /auth above.
      "/api": "http://localhost:3001",
    },
  },
});
