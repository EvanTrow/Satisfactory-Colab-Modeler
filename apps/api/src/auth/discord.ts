import type { DiscordConfig } from "./config.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";

/**
 * The subset of Discord's token-exchange response we touch. `access_token`
 * and `refresh_token` are handled at the callback route's discretion and
 * MUST NOT be persisted anywhere (PLAN.md §6 — "DISCARD the Discord
 * tokens"). This type exists only to make that boundary explicit, not to
 * invite storing more of it.
 */
export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface DiscordUserProfile {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

/**
 * The boundary between our routes and Discord's HTTP API. Routes depend on
 * this interface, not on `fetch` directly, so tests can inject a fake
 * implementation instead of making live calls to Discord (see
 * `apps/api/src/auth/routes.test.ts`).
 */
export interface DiscordClient {
  exchangeCodeForToken(code: string, codeVerifier: string): Promise<DiscordTokenResponse>;
  fetchCurrentUser(accessToken: string): Promise<DiscordUserProfile>;
}

/**
 * Builds the `https://discord.com/oauth2/authorize` redirect URL for
 * `GET /auth/discord/login`. `scope=identify` only — PLAN.md §6 is explicit
 * that requesting `email` adds a consent-screen field and a PII-retention
 * duty for something this app never needs.
 */
export function buildAuthorizeUrl(
  config: DiscordConfig,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * The real `DiscordClient`, backed by `fetch`. `fetchImpl` defaults to the
 * global `fetch` (available on Node >=20 per this repo's `engines` field)
 * but is an explicit parameter so tests can swap in a mock without any
 * module-mocking magic.
 */
export function createDiscordClient(
  config: DiscordConfig,
  fetchImpl: typeof fetch = fetch,
): DiscordClient {
  return {
    async exchangeCodeForToken(code, codeVerifier) {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
      });

      const res = await fetchImpl(`${DISCORD_API_BASE}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!res.ok) {
        // Deliberately not logging the response body: on some error paths
        // Discord echoes back request parameters, and we'd rather not risk
        // ever putting anything token-adjacent in logs.
        throw new Error(`Discord token exchange failed with status ${res.status}`);
      }

      return (await res.json()) as DiscordTokenResponse;
    },

    async fetchCurrentUser(accessToken) {
      const res = await fetchImpl(`${DISCORD_API_BASE}/users/@me`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        throw new Error(`Discord user fetch failed with status ${res.status}`);
      }

      return (await res.json()) as DiscordUserProfile;
    },
  };
}
