import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { generatePkcePair, generateState } from "./pkce.js";

describe("generateState", () => {
  it("returns a 32-byte random value, base64url-encoded", () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(state, "base64url").length).toBe(32);
  });

  it("is different on every call", () => {
    const values = new Set(Array.from({ length: 50 }, () => generateState()));
    expect(values.size).toBe(50);
  });
});

describe("generatePkcePair", () => {
  it("produces a verifier and a matching S256 challenge", () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();

    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    // RFC 7636 requires 43-128 characters for the verifier.
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);

    const expectedChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    expect(codeChallenge).toBe(expectedChallenge);
  });

  it("is different on every call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});
