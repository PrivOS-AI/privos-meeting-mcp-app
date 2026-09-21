/**
 * Pure (no I/O) scoring/reporting for `calibrate-speaker-threshold.ts` — split
 * out so the FAR/FRR/EER, bucketing, centroid-trial, and margin-trial math is
 * unit-testable without embedding real audio.
 */
import { cosineSimilarity } from '../src/shared/cosine.js';

export interface Sample {
  person: string;
  file: string;
  vector: Float32Array;
  durationSec: number;
}

export const THRESHOLD_MIN = 0.3;
export const THRESHOLD_MAX = 0.8;
export const THRESHOLD_STEP = 0.01;

/** Clips per centroid, both sides of a genuine centroid trial — mirrors `canMerge`'s own `embeddingCount >= 3` gate, so this measures the SAME regime production's merge check operates in. */
export const CENTROID_N = 3;

export type DurationBucket = '2-3s' | '3-5s' | '>5s';
export const DURATION_BUCKETS: readonly DurationBucket[] = ['2-3s', '3-5s', '>5s'];

/** `null` for a clip shorter than the production turn floor (`SPEAKER_MIN_SEGMENT_SEC` default 2s) — never reaches embedding in real traffic, so it is reported once under "all" only, never in the bucketed breakdown. */
export function bucketFor(durationSec: number): DurationBucket | null {
  if (durationSec < 2) return null;
  if (durationSec < 3) return '2-3s';
  if (durationSec < 5) return '3-5s';
  return '>5s';
}

export function pairwiseScores(samples: readonly Sample[]): { genuine: number[]; impostor: number[] } {
  const genuine: number[] = [];
  const impostor: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const score = cosineSimilarity(samples[i].vector, samples[j].vector);
      if (samples[i].person === samples[j].person) genuine.push(score);
      else impostor.push(score);
    }
  }
  return { genuine, impostor };
}

export function farAt(impostor: readonly number[], threshold: number): number {
  if (impostor.length === 0) return 0;
  return impostor.filter((s) => s >= threshold).length / impostor.length;
}

export function frrAt(genuine: readonly number[], threshold: number): number {
  if (genuine.length === 0) return 0;
  return genuine.filter((s) => s < threshold).length / genuine.length;
}

/** False-merge rate at a session MERGE threshold: fraction of impostor (different-person) pairs scoring AT OR ABOVE it. */
export function falseMergeAt(impostor: readonly number[], threshold: number): number {
  return farAt(impostor, threshold);
}

/** False-split rate at a session MATCH threshold: fraction of genuine (same-person) pairs scoring BELOW it (the label-recycle check would wrongly open a new instance). */
export function falseSplitAt(genuine: readonly number[], threshold: number): number {
  return frrAt(genuine, threshold);
}

export function meanVector(vectors: readonly Float32Array[]): Float32Array {
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i] / vectors.length;
  return out;
}

/**
 * Per-person, per-bucket CENTROID trials — the regime session merge actually
 * operates in (centroid-vs-centroid, never single turns). A person needs
 * `>= 2*CENTROID_N` clips in a bucket to contribute a GENUINE trial (two
 * independent, non-overlapping `CENTROID_N`-clip centroids built from their
 * OWN clips); any two different people each with `>= CENTROID_N` clips
 * contribute an IMPOSTOR trial (their own single `CENTROID_N`-clip centroid,
 * or fewer if that is all they have).
 */
export function centroidTrials(samples: readonly Sample[]): { genuine: number[]; impostor: number[] } {
  const byPerson = new Map<string, Float32Array[]>();
  for (const s of samples) byPerson.set(s.person, [...(byPerson.get(s.person) ?? []), s.vector]);

  const genuine: number[] = [];
  for (const vectors of byPerson.values()) {
    if (vectors.length < 2 * CENTROID_N) continue;
    const a = meanVector(vectors.slice(0, CENTROID_N));
    const b = meanVector(vectors.slice(CENTROID_N, 2 * CENTROID_N));
    genuine.push(cosineSimilarity(a, b));
  }

  const centroidByPerson = new Map<string, Float32Array>();
  for (const [person, vectors] of byPerson) {
    if (vectors.length >= CENTROID_N) centroidByPerson.set(person, meanVector(vectors.slice(0, CENTROID_N)));
  }
  const people = [...centroidByPerson.keys()];
  const impostor: number[] = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      impostor.push(cosineSimilarity(centroidByPerson.get(people[i])!, centroidByPerson.get(people[j])!));
    }
  }
  return { genuine, impostor };
}

/**
 * Leave-one-out margin trials: for each clip, scores every OTHER person by
 * the max cosine against that person's own clips (mirrors
 * `speaker-matcher.ts`'s per-candidate scoring), finds best/second, and
 * records `best - second`. A trial is GENUINE when the best-scoring person is
 * the clip's own person (a correct top match), IMPOSTOR when it is not (the
 * top match was wrong) — split so the margin's effect on correct vs incorrect
 * matches can be read separately.
 */
export function marginTrials(samples: readonly Sample[]): { genuine: number[]; impostor: number[] } {
  const byPerson = new Map<string, Sample[]>();
  for (const s of samples) byPerson.set(s.person, [...(byPerson.get(s.person) ?? []), s]);

  const genuine: number[] = [];
  const impostor: number[] = [];
  for (const query of samples) {
    const scores: { person: string; score: number }[] = [];
    for (const [person, ownSamples] of byPerson) {
      const others = person === query.person ? ownSamples.filter((s) => s !== query) : ownSamples;
      if (others.length === 0) continue;
      const score = others.reduce((max, s) => Math.max(max, cosineSimilarity(query.vector, s.vector)), -1);
      scores.push({ person, score });
    }
    if (scores.length < 2) continue; // need at least 2 candidate people for a margin to mean anything
    scores.sort((a, b) => b.score - a.score);
    const margin = scores[0].score - scores[1].score;
    (scores[0].person === query.person ? genuine : impostor).push(margin);
  }
  return { genuine, impostor };
}

export function meanOf(values: readonly number[]): number {
  return values.length === 0 ? NaN : values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function printDistributionSummary(label: string, values: readonly number[]): void {
  if (values.length === 0) {
    console.log(`  ${label}: (no trials)`);
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`  ${label}: n=${values.length} mean=${meanOf(values).toFixed(3)} median=${median.toFixed(3)} min=${min.toFixed(3)} max=${max.toFixed(3)}`);
}

export function printBucketedDistributions(title: string, samples: readonly Sample[], trialsOf: (s: readonly Sample[]) => { genuine: number[]; impostor: number[] }): void {
  console.log(`\n== ${title}: ALL durations ==`);
  const all = trialsOf(samples);
  printDistributionSummary('genuine', all.genuine);
  printDistributionSummary('impostor', all.impostor);

  for (const bucket of DURATION_BUCKETS) {
    const inBucket = samples.filter((s) => bucketFor(s.durationSec) === bucket);
    console.log(`\n== ${title}: bucket ${bucket} (${inBucket.length} clips) ==`);
    const { genuine, impostor } = trialsOf(inBucket);
    printDistributionSummary('genuine', genuine);
    printDistributionSummary('impostor', impostor);
  }
}

export function printEerSweep(genuine: readonly number[], impostor: readonly number[]): { threshold: number; far: number; frr: number } | null {
  if (genuine.length === 0 || impostor.length === 0) {
    console.log('  (need >=1 genuine AND >=1 impostor trial for FAR/FRR — skipped)');
    return null;
  }
  let best = { threshold: THRESHOLD_MIN, far: 1, frr: 1, diff: Infinity };
  for (let t = THRESHOLD_MIN; t <= THRESHOLD_MAX + 1e-9; t += THRESHOLD_STEP) {
    const threshold = Math.round(t * 100) / 100;
    const far = farAt(impostor, threshold);
    const frr = frrAt(genuine, threshold);
    const diff = Math.abs(far - frr);
    if (diff < best.diff) best = { threshold, far, frr, diff };
  }
  console.log(`  suggested threshold (closest to EER): ${best.threshold.toFixed(2)} (FAR=${best.far.toFixed(3)}, FRR=${best.frr.toFixed(3)})`);
  return best;
}

export function sweepSessionThresholds(genuine: readonly number[], impostor: readonly number[]): void {
  const SESSION_MATCH_MIN = 0.25;
  const SESSION_MATCH_MAX = 0.6;
  const SESSION_MERGE_MIN = 0.45;
  const SESSION_MERGE_MAX = 0.8;
  const STEP = 0.01;

  console.log('\n  SPEAKER_SESSION_MATCH_THRESHOLD sweep (label-recycle check) — threshold -> false-split-rate');
  for (let t = SESSION_MATCH_MIN; t <= SESSION_MATCH_MAX + 1e-9; t += STEP) {
    const threshold = Math.round(t * 100) / 100;
    console.log(`  ${threshold.toFixed(2)}       ${falseSplitAt(genuine, threshold).toFixed(3)}`);
  }

  console.log('\n  SPEAKER_SESSION_MERGE_THRESHOLD sweep (centroid convergence merge) — threshold -> false-merge-rate');
  for (let t = SESSION_MERGE_MIN; t <= SESSION_MERGE_MAX + 1e-9; t += STEP) {
    const threshold = Math.round(t * 100) / 100;
    console.log(`  ${threshold.toFixed(2)}       ${falseMergeAt(impostor, threshold).toFixed(3)}`);
  }
}
