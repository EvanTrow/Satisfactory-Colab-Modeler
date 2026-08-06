import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64 } from "./base64";

describe("bytesToBase64 / base64ToBytes", () => {
  it("round-trips an empty array", () => {
    const bytes = new Uint8Array(0);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("round-trips small arbitrary bytes, including 0x00 and 0xff", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 42]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("round-trips bytes larger than the chunk size (exercises the chunked encode path)", () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }
    const roundTripped = base64ToBytes(bytesToBase64(bytes));
    expect(roundTripped).toEqual(bytes);
  });

  it("produces a string decodable by the platform's own atob (sanity check against a real base64 implementation)", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(btoa("Hello"));
  });
});
