/**
 * Speaker-embedding vector math, shared by the backend matcher (P4/P5) and any
 * calibration script. Pure functions over `Float32Array` — no crypto here; the
 * encryption boundary lives in the backend voiceprint layer (QĐ-06).
 */

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 when
 * either vector has zero magnitude (a degenerate embedding never "matches").
 * Throws on a length mismatch — comparing different-dim embeddings is a bug.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Encode a Float32 embedding as base64 (little-endian, platform-independent). */
export function encodeEmbedding(vec: Float32Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
  }
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Decode a base64 string produced by {@link encodeEmbedding} back to Float32Array. */
export function decodeEmbedding(base64: string): Float32Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    // Copy out of Node's shared allocation pool: `buf.buffer` is a pooled
    // ArrayBuffer and `byteOffset` is not guaranteed 4-byte aligned, so a
    // zero-copy Float32Array view could alias other data or throw RangeError.
    const usable = buf.byteLength & ~3;
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
