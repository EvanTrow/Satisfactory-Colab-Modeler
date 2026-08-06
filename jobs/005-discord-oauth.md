# Job 005: Discord OAuth2 login flow

**Phase:** 1 · Auth & projects
**Status:** Done
**Depends on:** 004 (core DB migrations — needs `users` and `sessions` tables)

## Context

Read [`PLAN.md`](../PLAN.md) section **6. Discord OAuth2 Flow** in full — it specifies the exact request/response sequence, cookie names, TTLs, and security properties (PKCE, state CSRF check, discarding Discord tokens after identity is established). Also read §10.1 (open question: guest access) — for this job, **do not** implement guest/anonymous accounts; that's an explicit open question, build the Discord-only path and leave a clear extension point.

## Scope

In scope:
- `GET /auth/discord/login` in `apps/api`: generates `state` (32 bytes random) + PKCE verifier/challenge, stores both in a short-lived signed httpOnly cookie (5 min TTL), redirects to Discord's authorize URL with `scope=identify` only (not `email` — PLAN.md is explicit about why).
- `GET /auth/discord/callback`: verifies `state` against the cookie (reject on mismatch — this is a security-critical check, write a test for it), exchanges the code for a token via Discord's token endpoint (using PKCE verifier + `client_secret`), fetches `GET /users/@me`, **discards the Discord access/refresh tokens immediately after** (do not persist them anywhere, including logs), upserts into `users` on `discord_id` conflict, creates a `sessions` row (32-byte random token, only the SHA-256 hash stored), and sets the `sfm_session` cookie exactly as specified (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`).
- Session validation middleware/plugin for `apps/api` that reads `sfm_session`, hashes it, looks up `sessions`, checks `expires_at`, and attaches the resolved user to the request context. Also bump `users.last_seen_at` and consider sliding-window session refresh (use judgement; not specified in PLAN.md, keep it simple).
- A `GET /auth/logout` (or similar) that deletes the session row and clears the cookie.
- A `GET /auth/me` endpoint returning the current session's user (or 401) — needed by the web app to know if it's logged in.
- Environment config for `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, documented in `.env.example`.

Out of scope:
- The realtime-ticket endpoint (`/api/realtime/ticket`) from PLAN.md §6's "Tying sessions to the WebSocket layer" subsection — that belongs to Job 020 (Hocuspocus server), since it's meaningless without the realtime server to hand tickets to.
- Any frontend login UI beyond what's needed to manually exercise the flow (a bare "Log in with Discord" link is enough here; Job 006 builds the real project-list-adjacent UI).
- Guest/anonymous accounts (PLAN.md open question — out of scope until explicitly requested).

## Deliverables

- `apps/api/src/routes/auth.ts` (or similar) implementing all routes above.
- Session middleware wired into the Fastify app.
- `.env.example` updated with the three Discord env vars.
- A minimal login link/button in `apps/web` sufficient to click through the flow manually.
- Tests: state-mismatch rejection, session expiry rejection, successful upsert-on-conflict for a returning user.

## Acceptance criteria

- Per PLAN.md §9 (Auth verification bullet): a Discord application registered with `http://localhost:5173/auth/discord/callback` (or the actual dev callback URL used) completes the full flow end to end — log in, land back in the app, `GET /auth/me` returns the user.
- State mismatch on callback is rejected with an appropriate error, not silently ignored.
- Sessions expire correctly (`expires_at` enforced) and expired sessions are rejected by the middleware.
- No Discord access/refresh token is ever written to the database or logs — grep the implementation to confirm.
- Re-authenticating an existing `discord_id` updates the existing `users` row rather than creating a duplicate.

## Notes for the worker

- You will need a real (or test) Discord application's client ID/secret to exercise this end to end locally — if none is available in this environment, implement and unit-test everything possible without live Discord calls (mock the token/user-info exchange), and clearly flag in Handoff notes that live verification is still needed.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).

## Handoff notes

**File layout — `apps/api/src/auth/`:**
- `pkce.ts` — `generateState()` (32 random bytes, base64url) and `generatePkcePair()` (S256 verifier/challenge per RFC 7636). Pure, no I/O.
- `config.ts` — `getAuthConfig()`: reads `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`/`DISCORD_REDIRECT_URI` (throws if any are missing — called lazily inside plugin registration, not at module load) and `COOKIE_SECRET` (falls back to an insecure dev default, same pattern as `db.ts`'s `DATABASE_URL` default). Loads `infra/.env` itself via `dotenv` (mirrors `db.ts`'s loader exactly; calling `dotenv.config()` twice across modules is a documented no-op, not a bug).
- `discord.ts` — `DiscordClient` interface (`exchangeCodeForToken`, `fetchCurrentUser`) is the seam between routes and Discord's real HTTP API. `createDiscordClient(config, fetchImpl = fetch)` is the real implementation; `fetchImpl` is an explicit parameter specifically so tests can inject a fake without module-mocking. `buildAuthorizeUrl()` builds the `discord.com/oauth2/authorize` redirect with `scope=identify` only (never `email`, per PLAN.md §6).
- `users.ts` — `upsertUserFromDiscordProfile()`: a real Kysely `.onConflict((oc) => oc.column("discord_id").doUpdateSet(...))` upsert (not select-then-insert), per Job 004's handoff note. Updates `username`/`global_name`/`avatar_hash`/`last_seen_at` on a returning user, never creates a duplicate row.
- `session.ts` — `createSession()` (generates a 32-byte random token, stores only `sha256(token)` as a `Buffer` in `sessions.token_hash`, retries up to 5x on a Postgres unique-violation on that column per Job 004's note that a collision must be handled, not assumed impossible), `findValidSession(token)` (hashes, looks up, returns `null` for both "unknown" and "expired" — callers don't need to distinguish), `deleteSessionByToken()`, `touchSession()` (see sliding-window note below). `SESSION_COOKIE_NAME = "sfm_session"`, `SESSION_TTL_MS = 2_592_000_000` (30 days, matches PLAN.md's `Max-Age=2592000`).
- `session-plugin.ts` — the session-validation middleware, exported as `sessionPlugin` (a `fastify-plugin`-wrapped plugin, so its decorations attach to the root app rather than being encapsulated). Registers `@fastify/cookie` itself (with `secret: cookieSecret` for signing the OAuth state cookie — pass `{ registerCookiePlugin: false }` if some later job needs to register `@fastify/cookie` itself instead). On every request, reads `sfm_session`, hashes it, resolves the session, and sets `request.user: User | null` / `request.session: Session | null` — **without rejecting the request**. It also decorates `fastify.authenticate`, an async `preHandler` that 401s (`{ error: "unauthorized" }`) if `request.user` is null.
- `routes.ts` — `authRoutes`, a `FastifyPluginAsync<AuthRoutesOptions>` registering all four routes below. `AuthRoutesOptions.discordClient` is the test injection point; `AuthRoutesOptions.postLoginRedirect` (default `"/"`) is where the callback redirects on success.
- `app.ts` (new, at `apps/api/src/app.ts`, not inside `auth/`) — `buildApp(opts)` factory extracted out of `index.ts` so tests can build a Fastify instance with a mocked `DiscordClient` and drive it with `app.inject()` instead of binding a real port. `index.ts` is now just `const app = await buildApp(); app.listen(...)`.

**Routes registered (all under `apps/api/src/auth/routes.ts`):**
- `GET /auth/discord/login` — mints `state` + PKCE pair, stores both as JSON in a signed, httpOnly, `Secure`, `SameSite=Lax` cookie (`sfm_oauth_state`, `Path=/auth/discord`, `Max-Age=300`), 302s to Discord's authorize URL.
- `GET /auth/discord/callback` — clears the state cookie unconditionally first (single-use regardless of outcome), then: 400s on `?error=`, 400s if `code`/`state`/the cookie are missing, 400s if the cookie fails to unsign or parse, **403s with `{ error: "state_mismatch" }` on any state mismatch** (constant-time compare via `crypto.timingSafeEqual`, length-checked first so mismatched lengths don't throw) — this is the security-critical check the job calls out, and it's covered by a dedicated test. On success: exchanges the code via the injected/real `DiscordClient`, fetches the profile, upserts the user, creates a session, sets `sfm_session` with the exact flags from PLAN.md §6 (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`), and 302s to `postLoginRedirect`.
- `GET /auth/logout` — deletes the session row (if the cookie is present) and clears `sfm_session`.
- `GET /auth/me` — gated by `{ preHandler: fastify.authenticate }`; 401s if not logged in, otherwise returns the user as camelCase JSON (`id`, `discordId`, `username`, `globalName`, `avatarHash`, `createdAt`, `lastSeenAt`).

**Discord tokens are never persisted or logged** — verified by grep (`grep -rn "access_token\|refresh_token\|tokenResponse\|accessToken" apps/api/src/auth/*.ts apps/api/src/app.ts apps/api/src/index.ts`): the token-exchange response is destructured into a local `accessToken` immediately, used once to call `fetchCurrentUser`, and never referenced again — never passed to `db`, never passed to `request.log` (error logs on the two Discord-call failure paths log `err.message` only, never the token response or request body).

**Session validation for Job 006 (and later jobs) to use, concretely:**
- Register `sessionPlugin` before any routes that need `request.user` (already done in `app.ts`; if Job 006 adds its own plugin-registration entrypoint, make sure `sessionPlugin` still runs first).
- For a route that requires a logged-in user: `fastify.get("/api/projects", { preHandler: fastify.authenticate }, async (request, reply) => { const user = request.user!; ... })`. `fastify.authenticate` already sent the 401 and short-circuited if `request.user` is null, so it's safe to non-null-assert inside the handler after that preHandler runs.
- For a route that behaves differently when logged in vs. not (rare, but possible for public/link-visibility projects), just read `request.user` directly — it's `null` rather than throwing when there's no session.
- `request.session` (the resolved `sessions` row) is also available if a route needs `session.id`/`expires_at`/etc., though most routes should only need `request.user`.
- **Sliding-window refresh** (PLAN.md doesn't specify this — job explicitly said "use judgement, keep it simple"): `touchSession()` always bumps `users.last_seen_at`, and additionally extends `sessions.expires_at` back out to a full 30 days from now **only** if the session is already more than halfway through its TTL (i.e., less than 15 days remain). This avoids a write to `sessions` on every single authenticated request while keeping active users logged in indefinitely. It runs fire-and-forget in the `onRequest` hook (errors are logged, not thrown, so a DB hiccup on the refresh never fails the request it's piggybacking on).

**Environment variables — documented in `infra/.env.example`** (the same file `apps/api/src/db.ts` already reads via `dotenv`, so no new env-loading mechanism was introduced):
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` — required; `apps/api/src/auth/config.ts` throws at plugin-registration time (i.e., at server startup, in both `pnpm dev` and `pnpm start`) if any are missing. This is a deliberate fail-fast: the api server won't start at all without Discord config, rather than starting and 500ing on first login attempt. `DISCORD_REDIRECT_URI` defaults (in `.env.example`) to `http://localhost:5173/auth/discord/callback` — **the web dev port, not the api's own 3001** — because `apps/web/vite.config.ts` now proxies `/auth/*` to `http://localhost:3001`, so the browser sees same-origin on 5173 and PLAN.md §9's verification bullet (which names the 5173 callback URL) is satisfied as-is.
- `COOKIE_SECRET` — signs only the 5-minute OAuth state cookie, not `sfm_session` (whose value is an opaque random token looked up by hash, so signing it would add nothing). Optional; falls back to an insecure hardcoded dev value if unset, same pattern as `DATABASE_URL`'s dev fallback in `db.ts`.
- The local (gitignored) `infra/.env` on this machine was updated with placeholder values (`dev-placeholder-client-id` / `dev-placeholder-client-secret` / a real-shaped redirect URI / a dev cookie secret) so `pnpm dev` and manual `curl` smoke tests work without real Discord credentials — these are NOT committed (only `infra/.env.example` is).

**Mocking approach for Discord, and what is NOT verified live:**
- `DiscordClient` (in `discord.ts`) is the injection seam. Tests construct a fake implementation of `exchangeCodeForToken`/`fetchCurrentUser` and pass it as `buildApp({ authRoutesOptions: { discordClient: fakeClient } })`, then drive the app with `app.inject()` — no network calls happen in any test.
- `discord.test.ts` separately unit-tests the real `createDiscordClient()` against a mocked global-`fetch`-shaped function (verifying the exact request shape sent to Discord — PKCE verifier, `client_secret`, `grant_type`, the Bearer header on `/users/@me` — without actually calling Discord).
- **What's NOT verified**: an actual end-to-end run against Discord's real OAuth servers with a real registered application. No Discord app credentials were available in this environment. Whoever picks this up next (or Job 006, when it starts needing real logins to build project-list UI against) should: register a Discord application, set `http://localhost:5173/auth/discord/callback` as its redirect, put real values in a local `infra/.env`, run `pnpm dev` for both `apps/web` and `apps/api`, and click through `http://localhost:5173` → "Log in with Discord" → consent screen → land back on `/` → confirm `GET /auth/me` returns the real Discord profile. This is PLAN.md §9's "Auth" verification bullet and the job's first acceptance-criteria bullet — both still owed.

**Web app changes — deliberately minimal per the job's scope note:**
- `apps/web/src/App.tsx` now calls `GET /auth/me` on mount and renders either a "Log in with Discord" link (→ `/auth/discord/login`) or "Logged in as `<name>`" + a "Log out" link (→ `/auth/logout`). No router, no styling beyond what was already there — Job 006 owns the real UI.
- `apps/web/vite.config.ts` gained a dev-server proxy: `/auth` → `http://localhost:3001` (see the `DISCORD_REDIRECT_URI` note above for why this exists).

**Docker/Postgres status — still broken on this machine, same as Job 004:** `docker info` hung indefinitely again (backgrounded after a 30s timeout with zero output; `Docker Desktop.exe`/`com.docker.backend.exe` processes were running per `tasklist`, but the daemon never became responsive). Did not attempt to force-kill or restart Docker Desktop — same reasoning as Job 004: this is the user's real machine, out of scope for a worker agent without explicit go-ahead, and not worth burning time on per this job's own instructions.
- **What was verified instead**: a throwaway native Postgres 16 instance (`initdb`/`pg_ctl` from `C:\Program Files\PostgreSQL\16\bin`, a fresh data dir under this session's scratchpad, port 5434, stopped with `pg_ctl stop -m fast` at the end of the session — never touched the user's own separately-running Postgres). `pnpm db:migrate` against it applied all five migrations cleanly (confirming Job 004's schema still applies with no drift). Against that instance:
  - `pnpm --filter @scm/api test` (23 tests across `pkce.test.ts`, `discord.test.ts`, `users.test.ts`, `session.test.ts`, `routes.test.ts`) — all passed, including the three tests the job explicitly required: state-mismatch rejection (`routes.test.ts`, 403 with `{ error: "state_mismatch" }`), session-expiry rejection (`session.test.ts`, a session with a backdated `expires_at` is rejected by `findValidSession`), and successful upsert-on-conflict for a returning user (both a unit-level test in `users.test.ts` and an end-to-end version in `routes.test.ts` that runs two full mocked-Discord login flows for the same `discord_id` and asserts a single row with updated fields).
  - A manual smoke test: ran `pnpm dev` for `apps/api` pointed at the throwaway Postgres with placeholder Discord env vars, then `curl`'d `/health` (200), `/auth/discord/login` (302 to a correctly-shaped `discord.com/oauth2/authorize` URL with `scope=identify`, `code_challenge_method=S256`, and a signed `sfm_oauth_state` cookie with `HttpOnly; Secure; SameSite=Lax; Max-Age=300`), and `/auth/me` with no cookie (401 `{"error":"unauthorized"}`) — confirming the routes work over real HTTP, not just via `fastify.inject()`, before tearing the dev server down.
  - **Follow-up for whoever picks up Job 006** (or anyone before it): once Docker Desktop is working again, run `docker compose -f infra/docker-compose.yml up -d && pnpm db:migrate` and re-run `pnpm --filter @scm/api test` against it as a parity check — no reason to expect a difference, but cheap insurance, same as Job 004 flagged.

**Testing/build plumbing added to `apps/api` (didn't exist before this job):**
- `vitest` added as a devDependency, `"test": "vitest run"` added to `apps/api/package.json` (apps/api had no test setup at all before this job — Jobs 002/003/004 tests all lived in `packages/*`).
- `apps/api/tsconfig.build.json` added (`extends ./tsconfig.json`, `exclude: ["src/**/*.test.ts"]`) and `"build"` in `package.json` now points at it instead of `tsconfig.json` directly — same pattern as `packages/rational`/`packages/gamedata`, needed so `*.test.ts` files don't end up compiled into `dist/`.
- New dependencies: `@fastify/cookie` (cookie parsing + HMAC signing for the OAuth state cookie — not mentioned by name in PLAN.md, which just says "signed httpOnly cookie", but it's the standard Fastify-ecosystem way to do that) and `fastify-plugin` (so `sessionPlugin`'s decorators attach to the root app instead of being scoped to its own encapsulation context — required for `fastify.authenticate` and `request.user` to be visible to routes registered as sibling plugins, e.g. Job 006's future project routes).

**Deviations from the spec:**
- The job says a route file "`apps/api/src/routes/auth.ts` (or similar)" — implemented instead as a small `apps/api/src/auth/` module (`routes.ts` plus its supporting files) rather than a single flat file, and pulled `app.ts` out of `index.ts` as a separate factory. Judged this as more in the spirit of "or similar" than a deviation worth reconsidering, since a single file would have mixed PKCE/config/Discord-HTTP/session-DB/route-handling concerns that are each independently unit-testable this way.
- Added a Vite dev-server proxy (`apps/web/vite.config.ts`) that wasn't explicitly requested — necessary to make `DISCORD_REDIRECT_URI=http://localhost:5173/...` (which PLAN.md §9 names explicitly) actually work with `apps/api` listening on its own port 3001.
- `apps/api`'s server now fails to start at all without `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`/`DISCORD_REDIRECT_URI` set (fail-fast at startup rather than lazily failing on first login attempt). Worth a second look if a later job wants `apps/api` to run in some Discord-agnostic mode (e.g. CI running only DB-related tests) — as implemented, even `/health` requires Discord env vars to be present (dummy values are enough).
