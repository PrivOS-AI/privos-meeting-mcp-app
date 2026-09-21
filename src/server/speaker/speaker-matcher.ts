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
  /**
   * Second-highest per-profile score seen — the accept/reject MARGIN, for
   * diagnostics only (never gates the decision above). 0 when fewer than two
   * distinct profiles had a dim-compatible embedding to compare.
   */
  runnerUpConfidence: number;
  /** Identity of the best-scoring profile, set even when it did NOT clear `threshold` (diagnostics only — `profileId` above stays the sole accept signal). */
  bestProfileId?: string;
  /** Identity of the second-best-scoring profile (diagnostics only). Undefined when there was no runner-up. */
  runnerUpProfileId?: string;
}

/**
 * Returns the best-matching profile above `threshold`, or a profile-less
 * result carrying the best score seen (so callers can still show "closest
 * was 0.42" in logs/UI without treating it as a match). Embeddings whose
 * length differs from `embedding.length` are skipped, never thrown on — a
 * model swap mid-workspace must degrade gracefully, not crash matching.
 *
 * Also tracks the runner-up (second-best per-profile score) purely for
 * diagnostics/calibration — it never changes `profileId`/`confidence`, which
 * keep their exact pre-existing meaning and gate every caller's decision the
 * same way they always have.
 */
export function matchSpeaker(embedding: Float32Array, profiles: readonly SpeakerProfile[], threshold: number): MatchResult {
  let best: { profileId: string; displayName: string; score: number } | undefined;
  let second: { profileId: string; score: number } | undefined;

  for (const profile of profiles) {
    let profileBest: number | undefined;
    for (const stored of profile.embeddings) {
      if (stored.vector.length !== embedding.length) continue;
      const score = cosineSimilarity(embedding, stored.vector);
      if (profileBest === undefined || score > profileBest) profileBest = score;
    }
    if (profileBest === undefined) continue;

    if (!best || profileBest > best.score) {
      if (best) second = { profileId: best.profileId, score: best.score };
      best = { profileId: profile.id, displayName: profile.displayName, score: profileBest };
    } else if (!second || profileBest > second.score) {
      second = { profileId: profile.id, score: profileBest };
    }
  }

  const runnerUpConfidence = second?.score ?? 0;
  if (!best) return { confidence: 0, runnerUpConfidence };

  const diagnostics = { runnerUpConfidence, bestProfileId: best.profileId, runnerUpProfileId: second?.profileId };
  if (best.score < threshold) return { confidence: best.score, ...diagnostics };
  return { profileId: best.profileId, displayName: best.displayName, confidence: best.score, ...diagnostics };
}
