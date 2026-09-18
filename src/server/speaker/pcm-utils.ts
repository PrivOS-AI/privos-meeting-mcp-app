/**
 * Small PCM helpers shared by the enrolment path (P4) and the live chunk
 * worker (P5): concatenating the ranges `segment-picker.ts` selected into one
 * buffer for embedding, and a cheap RMS energy check to skip near-silent
 * ranges before they ever reach the (comparatively expensive) embedding
 * extractor.
 */

/** Concatenates Float32 PCM parts (already normalized to [-1, 1]) into one buffer, in order. */
export function concatPcm(parts: readonly Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Root-mean-square energy of a PCM buffer, in [0, 1]. Empty input is treated as silence (0). */
export function rmsLevel(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < pcm.length; i++) sumSquares += pcm[i] * pcm[i];
  return Math.sqrt(sumSquares / pcm.length);
}

/** Below this RMS a range is treated as near-silence — not worth spending an embedding pass on. */
export const SILENCE_RMS_THRESHOLD = 0.005;

/** True when the PCM range carries enough energy to be worth embedding. */
export function hasSpeechEnergy(pcm: Float32Array, threshold: number = SILENCE_RMS_THRESHOLD): boolean {
  return rmsLevel(pcm) >= threshold;
}
