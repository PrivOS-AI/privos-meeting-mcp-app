/**
 * Matches one query embedding against every profile in the workspace. Scores
 * a profile by the MEAN of its top-3 individual-vector cosine scores (not the
 * single max over up to `EMBEDDING_CAP` vectors) — under max-scoring, a
 * profile's false-accept rate only grows as more vectors are enrolled (one
 * lucky/contaminated vector wins the match forever); the top-3 mean still
 * tolerates real mic/device variation (several vectors, not one averaged
 * centroid) while requiring more than a single outlier to agree.
 *
 * `matchSpeaker` itself never gates on a threshold — it only reports what it
 * saw. Every caller applies the SAME shared {@link acceptMatch} to decide
 * whether the best candidate is trusted, so the accept/margin rule can never
 * drift between call sites.
 *
 * This scoring is for PROFILE matching only (`speaker_profiles`, cross-meeting
 * recognition) — session-level assignment (which live session speaker a turn
 * belongs to, in the SAME meeting) has its own scoring function in
 * `session-speaker-registry.ts` and must never import this module.
 */
import { cosineSimilarity } from '../../shared/cosine.js';
import type { SpeakerProfile } from './profile-store.js';

/** How many of a profile's best individual-vector scores are averaged into its overall score. */
const TOP_N_FOR_SCORE = 3;

export interface ProfileScore {
  profileId: string;
  displayName: string;
  /** Mean of this profile's top `TOP_N_FOR_SCORE` individual-vector cosine scores against the query embedding. */
  score: number;
}

export interface MatchResult {
  /** Best-scoring profile seen, regardless of threshold — `undefined` only when no profile had a single dim-compatible embedding. */
  best?: ProfileScore;
  /** Second-best-scoring profile seen — `undefined` when fewer than two profiles had a dim-compatible embedding. */
  second?: ProfileScore;
}

/** This profile's score against `embedding`, or `undefined` when it has no dim-compatible embedding at all (never thrown on — a model swap mid-workspace must degrade gracefully). */
function profileScore(embedding: Float32Array, profile: SpeakerProfile): number | undefined {
  const scores: number[] = [];
  for (const stored of profile.embeddings) {
    if (stored.vector.length !== embedding.length) continue;
    scores.push(cosineSimilarity(embedding, stored.vector));
  }
  if (scores.length === 0) return undefined;
  scores.sort((a, b) => b - a);
  const top = scores.slice(0, TOP_N_FOR_SCORE);
  return top.reduce((sum, s) => sum + s, 0) / top.length;
}

/**
 * Scores `embedding` against every profile in the workspace and returns the
 * best and runner-up — never gated by a threshold (see {@link acceptMatch}).
 * Embeddings whose length differs from `embedding.length` are skipped.
 */
export function matchSpeaker(embedding: Float32Array, profiles: readonly SpeakerProfile[]): MatchResult {
  let best: ProfileScore | undefined;
  let second: ProfileScore | undefined;

  for (const profile of profiles) {
    const score = profileScore(embedding, profile);
    if (score === undefined) continue;
    const candidate: ProfileScore = { profileId: profile.id, displayName: profile.displayName, score };
    if (!best || score > best.score) {
      if (best) second = best;
      best = candidate;
    } else if (!second || score > second.score) {
      second = candidate;
    }
  }

  return { best, second };
}

export interface AcceptedMatch {
  profileId: string;
  displayName: string;
  /** `best.score` from the `MatchResult` this was accepted from. */
  confidence: number;
}

export interface AcceptMatchOptions {
  threshold: number;
  /**
   * Minimum gap required between `best` and `second` before the match is
   * trusted (`SPEAKER_MATCH_MARGIN`, neutral default 0 — trivially satisfied,
   * reproducing "accept on threshold alone"). When there is no `second` at
   * all the margin is trivially satisfied (nothing to be confused with).
   */
  margin: number;
}

/**
 * The ONE shared accept/reject decision every `matchSpeaker` caller uses —
 * never re-implemented per call site (plan.md: "margin applied by callers via
 * one shared acceptMatch"). Requires `best.score >= threshold` AND, only when
 * a second profile also scored, `best.score - second.score >= margin`: two
 * profiles that both sound close to the query are safer left unnamed than
 * named wrong.
 */
export function acceptMatch(result: MatchResult, options: AcceptMatchOptions): AcceptedMatch | undefined {
  if (!result.best || result.best.score < options.threshold) return undefined;
  if (result.second && result.best.score - result.second.score < options.margin) return undefined;
  return { profileId: result.best.profileId, displayName: result.best.displayName, confidence: result.best.score };
}
