// Browser-safe binary <-> base64 conversion. Deliberately not `Buffer` (not
// natively available in a browser bundle — `apps/web` has no Node polyfill
// for it) — `btoa`/`atob` are the web-platform primitives for this, both
// available as globals in every target this app runs in (browsers, and
// Node 18+/Vitest's node test environment, which is what `*.test.ts` in
// this app runs under).
//
// Chunked rather than a single `String.fromCharCode(...bytes)` spread: for
// a large-enough `Uint8Array` (tens of KB, easily reached by a merged batch
// of Yjs updates or the initial full-document load), spreading the whole
// array as call arguments can exceed the JS engine's max call-stack/argument
// count and throw `RangeError: Maximum call stack size exceeded`. 32KB
// chunks are comfortably under every engine's limit.
const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
