/**
 * Matches one query embedding against every profile in the workspace.
 * Compares against EACH stored embedding (not the centroid) and keeps the
 * max score — better tolerance for mic/device variation than a single
 * averaged vector (plan.md § Backend — match + ghi speaker map). `centroid`
 * exists only for display/quality metrics, never for matching.
 */
import { cosineSimilarity } from '../../shared/cosine.js';
import type { SpeakerProfile } from './profile-store.js';

export interface MatchResult {
  profileId?: string;
  displayName?: string;
  /** Best cosine score found, in [-1, 1]. 0 when there were no dim-compatible candidates at all. */
  confidence: number;
}

/**
 * Returns the best-matching profile above `threshold`, or a profile-less
 * result carrying the best score seen (so callers can still show "closest
 * was 0.42" in logs/UI without treating it as a match). Embeddings whose
 * length differs from `embedding.length` are skipped, never thrown on — a
 * model swap mid-workspace must degrade gracefully, not crash matching.
 */
export function matchSpeaker(embedding: Float32Array, profiles: readonly SpeakerProfile[], threshold: number): MatchResult {
  let best: { profileId: string; displayName: string; score: number } | undefined;

  for (const profile of profiles) {
    for (const stored of profile.embeddings) {
      if (stored.vector.length !== embedding.length) continue;
      const score = cosineSimilarity(embedding, stored.vector);
      if (!best || score > best.score) {
        best = { profileId: profile.id, displayName: profile.displayName, score };
      }
    }
  }

  if (!best) return { confidence: 0 };
  if (best.score < threshold) return { confidence: best.score };
  return { profileId: best.profileId, displayName: best.displayName, confidence: best.score };
}
