import { describe, expect, it, vi } from "vitest";

import { buildAuthorizeUrl, createDiscordClient } from "./discord.js";

const config = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:5173/auth/discord/callback",
};

describe("buildAuthorizeUrl", () => {
  it("requests scope=identify only, never email", () => {
    const url = new URL(buildAuthorizeUrl(config, { state: "s", codeChallenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
  });
});

describe("createDiscordClient (fetch mocked at the HTTP boundary)", () => {
  it("posts the PKCE verifier + client_secret to the token endpoint and returns the parsed token response", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://discord.com/api/v10/oauth2/token");
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("code")).toBe("the-code");
      expect(body.get("code_verifier")).toBe("the-verifier");
      expect(body.get("client_secret")).toBe(config.clientSecret);
      expect(body.get("grant_type")).toBe("authorization_code");
      return new Response(JSON.stringify({ access_token: "at", token_type: "Bearer", expires_in: 1, refresh_token: "rt", scope: "identify" }), {
        status: 200,
      });
    });

    const client = createDiscordClient(config, fetchMock as unknown as typeof fetch);
    const result = await client.exchangeCodeForToken("the-code", "the-verifier");

    expect(result.access_token).toBe("at");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fetches /users/@me with a Bearer token and returns the parsed profile", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://discord.com/api/v10/users/@me");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer the-access-token");
      return new Response(JSON.stringify({ id: "123", username: "tester", global_name: "Tester", avatar: null }), {
        status: 200,
      });
    });

    const client = createDiscordClient(config, fetchMock as unknown as typeof fetch);
    const profile = await client.fetchCurrentUser("the-access-token");

    expect(profile).toEqual({ id: "123", username: "tester", global_name: "Tester", avatar: null });
  });

  it("throws on a non-ok token response instead of swallowing the error", async () => {
    const fetchMock = vi.fn(async () => new Response("invalid_grant", { status: 400 }));
    const client = createDiscordClient(config, fetchMock as unknown as typeof fetch);
    await expect(client.exchangeCodeForToken("bad-code", "verifier")).rejects.toThrow(/400/);
  });
});
