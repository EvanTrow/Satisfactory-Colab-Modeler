// Deterministic edge IDs — PLAN.md §4, "Three deliberate choices" point 2:
//
//   "edgeId is a deterministic hash of (fromNode, fromPort, toNode, toPort).
//    If two users draw the same connection simultaneously they write the
//    same key and merge into one edge, instead of producing a duplicate."
//
// This is the concrete mechanism behind that guarantee: `edges` is a
// `Y.Map<edgeId, Y.Map>` (see schema.ts), so two `addEdge` calls with an
// identical 4-tuple must resolve to the identical map key for Yjs's
// last-writer-wins-per-key merge to collapse them into one entry rather than
// two.
//
// Algorithm: two independent 32-bit FNV-1a passes (different offset bases)
// over the same input, concatenated into a 16-hex-char (64-bit) string.
// FNV-1a is a simple, dependency-free, well-documented non-cryptographic
// hash with good avalanche behavior for short strings — plenty for merging
// UI-drawn connections, and keeping this pure/dependency-free matches the
// job's guidance to avoid pulling in a hashing library for something this
// small. A single 32-bit pass would start colliding around the 2^16
// (~65k edges, birthday bound) mark; doubling to 64 bits pushes that well
// past any plausible factory size.
//
// The four components are joined with a U+0000 (NUL) separator — a
// character that cannot appear in a Yjs map key sourced from UI-generated
// IDs — so that e.g. fromNode="a", fromPort="b:c" can never collide with
// fromNode="a:b", fromPort="c" by producing the same joined string.

const FNV_OFFSET_BASIS_A = 0x811c9dc5;
const FNV_OFFSET_BASIS_B = 0x9e3779b9; // arbitrary distinct seed (golden-ratio constant)
const FNV_PRIME = 0x01000193;
const SEPARATOR = String.fromCharCode(0);

function fnv1a32(input: string, offsetBasis: number): number {
  let hash = offsetBasis;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by the FNV prime using Math.imul to stay in 32-bit space
    // without losing precision to floating point.
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Force unsigned 32-bit representation.
  return hash >>> 0;
}

function toHex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/**
 * Deterministically derives an `edgeId` from a connection's four endpoints.
 * Same inputs always produce the same output — including across separate
 * clients/processes — which is what lets two concurrent identical
 * connection drags merge into a single Yjs map entry instead of duplicating.
 */
export function computeEdgeId(
  fromNode: string,
  fromPort: string,
  toNode: string,
  toPort: string,
): string {
  const key = [fromNode, fromPort, toNode, toPort].join(SEPARATOR);
  const a = fnv1a32(key, FNV_OFFSET_BASIS_A);
  const b = fnv1a32(key, FNV_OFFSET_BASIS_B);
  return `e_${toHex8(a)}${toHex8(b)}`;
}
