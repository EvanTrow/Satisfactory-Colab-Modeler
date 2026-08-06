# Job 005: Discord OAuth2 login flow

**Phase:** 1 · Auth & projects
**Status:** Not started
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
