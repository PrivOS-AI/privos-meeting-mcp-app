/**
 * Pure merge-decision policy for `session-speaker-registry.ts`'s `maybeMerge`
 * — split out so the identity guard, min-speech guard, and sustained-evidence
 * streak bookkeeping are unit-testable without spinning up a whole registry.
 * No I/O; the only dependency on the registry module is a type-only import
 * (`NameSource`), erased at compile time, so there is no runtime cycle.
 *
 * A merge is irreversible, so every gate here defaults to reproducing
 * TODAY'S single-shot behaviour (see `nextMergeStreak`'s doc comment) and is
 * only tightened once `.env` gates are flipped after calibration.
 */
import type { NameSource } from './session-speaker-registry.js';

export type MergeBlockReason = 'identity' | 'min-speech' | 'streak';

/** The subset of a session speaker's state this policy needs — never the full internal shape. */
export interface MergeCandidate {
  centroid: Float32Array;
  speechSec: number;
  embeddingCount: number;
  displayName?: string;
  profileId?: string;
  nameSource?: NameSource;
}

export interface MergeGuardResult {
  ok: boolean;
  blockedBy?: 'identity' | 'min-speech';
}

/** `sorted(idA, idB)` joined by a separator that can never appear in a UUID — stable regardless of call order; the registry's `mergeStreaks` map key. */
export function mergePairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}\u0000${idB}` : `${idB}\u0000${idA}`;
}

/**
 * Never merge two speakers a human or a voiceprint has already told apart:
 * different `profileId` on both sides, or both `nameSource:'user'` with a
 * different `displayName`. One side named + the other unnamed is NOT a
 * conflict — it may merge, and the winner keeps the name (`identityOutranks`).
 */
function hasConflictingIdentity(a: MergeCandidate, b: MergeCandidate): boolean {
  if (a.profileId && b.profileId && a.profileId !== b.profileId) return true;
  if (a.nameSource === 'user' && b.nameSource === 'user' && a.displayName && b.displayName && a.displayName !== b.displayName) return true;
  return false;
}

/**
 * Same user-given name/profile on BOTH sides — the user has already told the
 * two chips apart as the SAME person. An explicit merge request bypasses the
 * sustained-evidence streak (still subject to the guards in `canMerge`, which
 * trivially pass here since the identities agree by construction).
 */
export function isExplicitMergeRequest(a: MergeCandidate, b: MergeCandidate): boolean {
  if (a.profileId && b.profileId) return a.profileId === b.profileId;
  if (a.nameSource === 'user' && b.nameSource === 'user' && a.displayName && b.displayName) return a.displayName === b.displayName;
  return false;
}

/**
 * Identity + min-speech/embedding-count guards — no streak/threshold logic;
 * the caller already knows `cos >= mergeThreshold` before calling this.
 * `minSpeechSec <= 0` disables the min-speech gate entirely (neutral default
 * reproduces today's behaviour, which never checked speech volume at all).
 */
export function canMerge(a: MergeCandidate, b: MergeCandidate, opts: { minSpeechSec: number }): MergeGuardResult {
  if (hasConflictingIdentity(a, b)) return { ok: false, blockedBy: 'identity' };
  if (opts.minSpeechSec > 0) {
    const enoughSpeech = a.speechSec >= opts.minSpeechSec && b.speechSec >= opts.minSpeechSec;
    const enoughEmbeddings = a.embeddingCount >= 3 && b.embeddingCount >= 3;
    if (!enoughSpeech || !enoughEmbeddings) return { ok: false, blockedBy: 'min-speech' };
  }
  return { ok: true };
}

/** Precedence rank for "who keeps the name" after a merge: user > profile/live/async > none. */
function identityRank(c: Pick<MergeCandidate, 'profileId' | 'nameSource'>): number {
  if (c.nameSource === 'user') return 2;
  if (c.profileId || c.nameSource === 'live' || c.nameSource === 'async') return 1;
  return 0;
}

/**
 * `true` when `challenger`'s identity should REPLACE `incumbent`'s after a
 * merge — strictly higher precedence only; a tie (including "neither has a
 * name") keeps the incumbent (the speechSec-based merge winner) untouched.
 * Matches plan.md: "winner keeps name by precedence ... regardless of who has
 * more speech" — today a named loser's name was dropped whenever the winner
 * already had any name at all, even a weaker one.
 */
export function identityOutranks(challenger: Pick<MergeCandidate, 'profileId' | 'nameSource'>, incumbent: Pick<MergeCandidate, 'profileId' | 'nameSource'>): boolean {
  return identityRank(challenger) > identityRank(incumbent);
}

// ------------------------------------------------------- sustained evidence

function sameVector(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** One pair's sustained-evidence bookkeeping — opaque to the registry, which only stores/deletes this by `mergePairKey`. */
export interface MergeStreakEntry {
  count: number;
  lastCentroidA: Float32Array;
  lastCentroidB: Float32Array;
}

export interface MergeStreakResult {
  /** The streak count AFTER this check (0 when the check fell below threshold). */
  count: number;
  /** `true` once `requiredStreak` consecutive qualifying checks have been seen. */
  satisfied: boolean;
}

/**
 * Advances one pair's merge streak for a single `observe()`-triggered check.
 * A check QUALIFIES when `cos >= threshold` AND at least one of the two
 * centroids differs from what was recorded on the previous check (the
 * first-ever check for a pair always counts as "changed" — nothing to compare
 * against yet, so `SPEAKER_SESSION_MERGE_STREAK=1` reproduces today's
 * single-shot-merge behaviour exactly). `cos < threshold` always resets
 * (forgets) the pair. A qualifying-threshold check whose centroids are
 * IDENTICAL to the last one (no new evidence arrived since) neither advances
 * nor resets the streak — it is simply not informative.
 */
export function nextMergeStreak(
  prev: MergeStreakEntry | undefined,
  cos: number,
  threshold: number,
  centroidA: Float32Array,
  centroidB: Float32Array,
  requiredStreak: number,
): MergeStreakResult {
  if (cos < threshold) return { count: 0, satisfied: false };

  const changed = !prev || !sameVector(prev.lastCentroidA, centroidA) || !sameVector(prev.lastCentroidB, centroidB);
  const count = changed ? (prev?.count ?? 0) + 1 : (prev?.count ?? 0);
  return { count, satisfied: count >= Math.max(1, requiredStreak) };
}
