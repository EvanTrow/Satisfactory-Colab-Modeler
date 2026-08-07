// Job 020: a small, deliberately separate `http.createServer()` for the
// membership-changed webhook `apps/api` calls (see
// `apps/api/src/realtime/notify.ts`'s header comment for the cross-process
// half of this mechanism).
//
// Why not Hocuspocus's own `onRequest` extension hook, which runs on the
// *same* port as the WebSocket server? Investigated and rejected: Hocuspocus's
// `Server.requestHandler` (packages/server/src/Server.ts) always calls
// `response.writeHead(200,...).end("Welcome to Hocuspocus!")` immediately
// after the `onRequest` hook chain resolves, with no check for whether an
// extension already wrote/ended the response. An `onRequest` handler that
// fully answers a request (as this webhook needs to) would have Hocuspocus
// immediately try to write a second response on top of it, throwing
// `ERR_HTTP_HEADERS_SENT` and surfacing as an unhandled rejection on every
// single webhook call. A second listener on its own port sidesteps that
// entirely, at the cost of one more port to configure — worth it over
// fighting a library internal that isn't designed for "fully handle this
// request yourself." Never exposed publicly in a real deployment: only
// `apps/api` should be able to reach it (firewall/reverse-proxy rule in
// production; unrestricted in dev, same trust boundary as the rest of this
// single-container deployment).
import http from "node:http";

export interface InternalServerOptions {
  port: number;
  /** Must match the `x-internal-secret` header `apps/api`'s `notify.ts` sends. */
  secret: string;
  /** Reconciles (and force-disconnects, if warranted) `userId`'s connection(s) on `projectId` — see `revocation.ts`. */
  onMembershipChanged: (projectId: string, userId?: string) => Promise<number>;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function startInternalServer(options: InternalServerOptions): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, options).catch((err: unknown) => {
      console.error("[internal server] request handler failed", err);
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    });
  });

  server.listen(options.port);
  return server;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: InternalServerOptions,
): Promise<void> {
  if (req.method === "GET" && req.url === "/internal/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }

  if (req.method === "POST" && req.url === "/internal/membership-changed") {
    if (req.headers["x-internal-secret"] !== options.secret) {
      res.writeHead(401).end();
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      res.writeHead(400).end("invalid_json");
      return;
    }

    const { projectId, userId } = (body ?? {}) as { projectId?: unknown; userId?: unknown };
    if (typeof projectId !== "string" || projectId.length === 0) {
      res.writeHead(400).end("missing_project_id");
      return;
    }

    const closed = await options.onMembershipChanged(projectId, typeof userId === "string" ? userId : undefined);
    res.writeHead(204, { "x-closed-connections": String(closed) }).end();
    return;
  }

  res.writeHead(404).end();
}
