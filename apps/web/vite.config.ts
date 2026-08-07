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
      // Job 020: apps/realtime's Hocuspocus WebSocket, on its own port in
      // dev (default 1234 — see apps/realtime/src/config.ts). Ticket auth
      // (not cookies) is what actually secures this connection, so this
      // proxy isn't load-bearing for auth the way /api's is — it's here so
      // dev matches the same-origin shape of a real deployment (one
      // reverse-proxied host in front of apps/web + apps/api + apps/realtime,
      // per PLAN.md's "single container host" decision), and so
      // `realtimeTicket.ts`'s `getRealtimeWsUrl()` can default to a plain
      // same-origin `/collab` without needing to know apps/realtime's actual
      // port. `ws: true` is required for Vite's proxy to upgrade the
      // connection instead of treating it as a plain HTTP request.
      "/collab": { target: "http://localhost:1234", ws: true },
    },
  },
});
