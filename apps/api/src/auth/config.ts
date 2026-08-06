import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

// Mirrors apps/api/src/db.ts's env loading exactly (see that file's comment
// for the full rationale) — apps/api has no `.env` of its own, so both
// modules read `infra/.env`. Calling `loadEnv` a second time here is safe:
// dotenv never overrides variables already present in `process.env`, and
// silently no-ops if the file doesn't exist.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../../infra/.env") });

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthConfig {
  discord: DiscordConfig;
  /** Secret(s) used to sign the short-lived OAuth `state`/PKCE cookie. */
  cookieSecret: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy infra/.env.example to infra/.env and fill in a Discord application's credentials.`,
    );
  }
  return value;
}

// Only used to sign the 5-minute OAuth state cookie, never the session
// cookie (whose value is an opaque random token looked up by hash — signing
// it would add nothing). A dev-only fallback so `pnpm dev` works out of the
// box, same pattern as db.ts's DATABASE_URL default; production deploys
// should set a real COOKIE_SECRET.
const DEV_COOKIE_SECRET = "dev-insecure-cookie-secret-do-not-use-in-production";

/**
 * Reads Discord OAuth + cookie-signing config from the environment.
 * Throws if a required Discord variable is missing — call this lazily
 * (inside a route/plugin factory, not at module load) so importing this
 * module never has a side effect of crashing a process that doesn't need
 * Discord config yet (e.g. a test that only exercises session validation).
 */
export function getAuthConfig(): AuthConfig {
  return {
    discord: {
      clientId: requireEnv("DISCORD_CLIENT_ID"),
      clientSecret: requireEnv("DISCORD_CLIENT_SECRET"),
      redirectUri: requireEnv("DISCORD_REDIRECT_URI"),
    },
    cookieSecret: process.env.COOKIE_SECRET ?? DEV_COOKIE_SECRET,
  };
}
