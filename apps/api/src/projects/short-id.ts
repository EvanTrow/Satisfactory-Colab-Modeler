import crypto from "node:crypto";

/**
 * Generates a short, URL-friendly project id, e.g. `/p/k3n9wq2` per
 * PLAN.md §4's example. Kept simple per the job's own guidance
 * ("nanoid-style random string, just enforce the `unique` constraint from
 * the migration") — no new dependency, `crypto.randomBytes` base64url-
 * encoded is already URL-safe (`A-Z a-z 0-9 - _`, no padding).
 *
 * 8 random bytes -> 11 base64url characters. Collision probability at any
 * realistic project count is negligible, and `createProject`/
 * `duplicateProject` retry on a unique-violation the same way
 * `auth/session.ts`'s `createSession` retries on a token-hash collision —
 * so this doesn't need to be cryptographically collision-proof on its own.
 */
export function generateShortId(): string {
  return crypto.randomBytes(8).toString("base64url");
}
