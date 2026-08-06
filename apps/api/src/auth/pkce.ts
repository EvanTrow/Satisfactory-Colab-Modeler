import crypto from "node:crypto";

/**
 * Generates the CSRF `state` parameter for the OAuth2 authorization request:
 * 32 bytes of randomness, base64url-encoded (PLAN.md §6).
 */
export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export interface PkcePair {
  /** The secret kept server-side (in the short-lived state cookie) and sent to the token endpoint. */
  codeVerifier: string;
  /** The SHA-256/base64url digest of the verifier, sent in the authorize redirect. */
  codeChallenge: string;
}

/**
 * Generates a PKCE (RFC 7636) verifier/challenge pair using the `S256`
 * challenge method. The verifier is 32 random bytes, base64url-encoded
 * (43 characters — within the RFC's required 43-128 character range).
 */
export function generatePkcePair(): PkcePair {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
