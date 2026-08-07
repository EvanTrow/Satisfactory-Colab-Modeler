// Job 029: the "single container host" reverse proxy — PLAN.md's
// confirmed decision, and something `apps/web/src/canvas/persistence/
// realtimeTicket.ts`'s `getRealtimeWsUrl()` already assumes exists ("in a
// real deployment [apps/realtime] sits behind the same reverse proxy as
// everything else in this 'single container host'" — see that function's
// own header comment, unchanged since Job 020). This is what actually
// makes that assumption true: it's the ONE public port a real host
// (Fly.io/Railway/Render) points at, and it fans out to `apps/api`
// (serving `apps/web`'s static build too, see `apps/api/src/staticSite.ts`)
// on `API_PORT` for everything, and `apps/realtime`'s public Hocuspocus
// WebSocket listener on `REALTIME_PORT` for `/collab*` — both plain
// `127.0.0.1` processes in the SAME container, never exposed individually.
// `apps/realtime`'s *internal* webhook port (`REALTIME_INTERNAL_PORT`,
// 1235 by default) is deliberately never proxied here — it's for
// `apps/api`'s own direct `127.0.0.1` calls only (see
// `infra/.env.example`'s comment on that variable), so it never appears in
// this file at all.
//
// Deliberately its OWN tiny standalone Node script with its OWN isolated
// `node_modules` (installed by `infra/Dockerfile`, not a pnpm workspace
// member) rather than a fifth `apps/*` workspace package — this is pure
// infra glue with no product logic, no tests of its own beyond what
// running the real container proves, and adding it to the workspace would
// make every future job's `pnpm -r build/typecheck/test` traverse a
// package that has nothing to do with the product. `infra/` is already
// documented (root README) as "Dockerfile, deploy config" — this fits
// exactly there.
import httpProxy from "http-proxy";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const API_TARGET = `http://127.0.0.1:${process.env.API_PORT ?? 3001}`;
const REALTIME_TARGET = `http://127.0.0.1:${process.env.REALTIME_PORT ?? 1234}`;

const proxy = httpProxy.createProxyServer({ ws: true });

proxy.on("error", (err, _req, res) => {
  console.error("[proxy] upstream error:", err.message);
  // `res` is a `net.Socket` for a WebSocket upgrade error, not a real
  // `ServerResponse` — only try the HTTP error-response shape when it
  // actually looks like one (has `writeHead`), matching http-proxy's own
  // documented "error event may receive either" caveat.
  if (res && typeof res.writeHead === "function" && !res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("upstream unavailable");
  } else if (res && typeof res.destroy === "function") {
    res.destroy();
  }
});

function targetFor(url) {
  return url.startsWith("/collab") ? REALTIME_TARGET : API_TARGET;
}

const server = http.createServer((req, res) => {
  proxy.web(req, res, { target: targetFor(req.url ?? "/") });
});

// WebSocket upgrade (the Hocuspocus connection) — proxied separately from
// plain HTTP requests per http-proxy's own API (`ws()` vs `web()`), driven
// by the exact same `targetFor` routing rule so the two can never drift
// apart into "the HTTP fallback and the WS upgrade disagree about which
// port owns `/collab`".
server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head, { target: targetFor(req.url ?? "/") });
});

server.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT} -> api ${API_TARGET}, realtime(/collab*) ${REALTIME_TARGET}`);
});
