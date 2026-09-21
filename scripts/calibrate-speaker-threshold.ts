#!/usr/bin/env -S npx tsx
/**
 * `npm run calibrate:speaker -- ./samples` — measures FAR/FRR/EER for the
 * currently configured `SPEAKER_MODEL_PATH` against a labeled sample set, to
 * pick a real `SPEAKER_MATCH_THRESHOLD` instead of the plan's unverified
 * default (plan.md open question #5 — EER/model choice unresolved by design
 * until this script is run against real recordings).
 *
 * `npm run calibrate:speaker -- ./samples --session` — same sample set and
 * embeddings, but sweeps the TWO in-session live thresholds P5 introduced
 * (`SPEAKER_SESSION_MATCH_THRESHOLD` 0.25->0.60, `SPEAKER_SESSION_MERGE_THRESHOLD`
 * 0.45->0.80) and prints a false-merge / false-split table instead of
 * FAR/FRR: at a given `SPEAKER_SESSION_MERGE_THRESHOLD`, an IMPOSTOR pair
 * scoring above it is a false merge (two different people folded into one
 * session speaker); at a given `SPEAKER_SESSION_MATCH_THRESHOLD`, a GENUINE
 * pair scoring below it is a false split (the same person's label-recycle
 * check wrongly opens `label@n`). Same unresolved-by-design open question
 * (#9's neighbor — session thresholds are also unverified defaults) this
 * script exists to close once run against real same-session recordings.
 *
 * Input layout: `<dir>/<person>/<file>.wav` — one subfolder per person, each
 * containing one or more 16kHz mono PCM16 wav clips of ONLY that person
 * speaking (same format `decode-audio.ts` produces: 44-byte canonical
 * header, `pcm_s16le`; also the layout `scripts/extract-calibration-slices.ts`
 * writes). Re-encode with `ffmpeg -i in.ext -ac 1 -ar 16000 -c:a pcm_s16le
 * out.wav` first if needed.
 *
 * Phase-4 additions (real-meeting calibration, unbucketed reporting alone is
 * not enough on 2-5s shared-mic turns) — the actual scoring/bucketing math
 * lives in `calibration-metrics.ts`, kept pure/testable and separate from
 * this file's I/O + CLI orchestration:
 *  - Every genuine/impostor pairwise set is ALSO broken down by DURATION
 *    BUCKET (`2-3s`, `3-5s`, `>5s` — clips shorter than 2s, the production
 *    turn floor `SPEAKER_MIN_SEGMENT_SEC`, are reported once under "all" only,
 *    same as before, but excluded from the bucketed breakdown).
 *  - CENTROID trials, per bucket: session merge compares CENTROIDS (an
 *    N-embedding mean), never single turns, so alongside the single-embedding
 *    genuine/impostor sets this script also builds one centroid per person per
 *    bucket from `CENTROID_N` clips (mirrors `canMerge`'s own `embeddingCount
 *    >= 3` gate) and reports genuine (same person, two independent
 *    non-overlapping centroids) vs impostor (different people's centroids)
 *    cosine distributions — a person/bucket needs `>= 2*CENTROID_N` clips to
 *    contribute a genuine centroid trial, `>= CENTROID_N` for an impostor one.
 *  - Margin statistics: for each clip (leave-one-out), scores every person by
 *    the MAX cosine against that person's OTHER clips (mirrors
 *    `speaker-matcher.ts`'s per-candidate scoring), finds the best- and
 *    second-best-scoring person, and records `best - second` as a GENUINE
 *    trial when the best-scoring person is the clip's own person, or an
 *    IMPOSTOR trial otherwise (the best match was wrong) — informs whether
 *    `SPEAKER_MATCH_MARGIN`/session merge's identity guard would help without
 *    rejecting correct matches.
 *
 * Default mode prints all of the above for FAR/FRR/EER; `--session` prints the
 * false-merge/false-split table, also bucketed + centroid + margin.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { computeEmbedding } from '../src/server/speaker/embedding-extractor.js';
import { readWavPcm } from '../src/server/media/decode-audio.js';
import {
  DURATION_BUCKETS,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  THRESHOLD_STEP,
  bucketFor,
  centroidTrials,
  farAt,
  frrAt,
  marginTrials,
  pairwiseScores,
  printBucketedDistributions,
  printDistributionSummary,
  printEerSweep,
  sweepSessionThresholds,
  type Sample,
} from './calibration-metrics.js';

const WAV_HEADER_BYTES = 44;
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

function wavDurationSec(filePath: string): number {
  const { size } = statSync(filePath);
  const pcmBytes = Math.max(0, size - WAV_HEADER_BYTES);
  return pcmBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
}

async function loadSamples(rootDir: string): Promise<Sample[]> {
  const people = readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (people.length === 0) {
    throw new Error(`No speaker folders found in "${rootDir}" (expected structure <dir>/<person>/<file>.wav).`);
  }

  const samples: Sample[] = [];
  for (const person of people) {
    const personDir = path.join(rootDir, person.name);
    const files = readdirSync(personDir).filter((f) => f.toLowerCase().endsWith('.wav'));
    for (const file of files) {
      const filePath = path.join(personDir, file);
      const durationSec = wavDurationSec(filePath);
      if (durationSec < 0.5) {
        console.warn(`  skipping "${filePath}" — too short (${durationSec.toFixed(2)}s).`);
        continue;
      }
      const pcm = await readWavPcm(filePath, 0, durationSec);
      const vector = await computeEmbedding(pcm, SAMPLE_RATE);
      samples.push({ person: person.name, file, vector, durationSec });
      console.log(`  embedded ${person.name}/${file} (${durationSec.toFixed(1)}s, dim=${vector.length})`);
    }
  }
  return samples;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sessionMode = args.includes('--session');
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('Usage: npm run calibrate:speaker -- <sample-dir> [--session]');
    process.exitCode = 1;
    return;
  }

  console.log(`Extracting embeddings from "${dir}"...`);
  let samples: Sample[];
  try {
    samples = await loadSamples(path.resolve(dir));
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const byPerson = new Map<string, number>();
  for (const s of samples) byPerson.set(s.person, (byPerson.get(s.person) ?? 0) + 1);
  console.log(`\nEmbedded ${samples.length} samples from ${byPerson.size} people:`, Object.fromEntries(byPerson));

  const { genuine, impostor } = pairwiseScores(samples);
  console.log(`\nSame-person pairs (genuine): ${genuine.length} · Different-person pairs (impostor): ${impostor.length}\n`);

  if (genuine.length === 0 || impostor.length === 0) {
    console.error('Need at least 2 people with >=2 samples each for a meaningful FAR/FRR.');
    process.exitCode = 1;
    return;
  }

  if (sessionMode) {
    console.log('== SPEAKER_SESSION_MATCH_THRESHOLD / SPEAKER_SESSION_MERGE_THRESHOLD (single-embedding, ALL durations) ==');
    sweepSessionThresholds(genuine, impostor);
    printBucketedDistributions('single-embedding cosine', samples, pairwiseScores);
    printBucketedDistributions('N-embedding centroid cosine (SPEAKER_SESSION_MERGE_THRESHOLD regime)', samples, centroidTrials);
    console.log('\n== margin (best - second scoring person), split by whether the top match was correct ==');
    const margins = marginTrials(samples);
    printDistributionSummary('genuine (top match correct)', margins.genuine);
    printDistributionSummary('impostor (top match WRONG)', margins.impostor);
    console.log(
      '\nPick SPEAKER_SESSION_MATCH_THRESHOLD as the highest value with an acceptably low false-split-rate, and\n'
        + 'SPEAKER_SESSION_MERGE_THRESHOLD (which MUST stay above SPEAKER_SESSION_MATCH_THRESHOLD) as the lowest value\n'
        + 'with an acceptably low false-merge-rate on the CENTROID (not single-embedding) distribution above — that is\n'
        + 'the regime `maybeMerge` actually compares in production.',
    );
    return;
  }

  console.log('== SPEAKER_MATCH_THRESHOLD (single-embedding, ALL durations) ==');
  console.log('threshold  FAR      FRR      |FAR-FRR|');
  for (let t = THRESHOLD_MIN; t <= THRESHOLD_MAX + 1e-9; t += THRESHOLD_STEP) {
    const threshold = Math.round(t * 100) / 100;
    console.log(`${threshold.toFixed(2)}       ${farAt(impostor, threshold).toFixed(3)}    ${frrAt(genuine, threshold).toFixed(3)}`);
  }
  printEerSweep(genuine, impostor);

  console.log('\n== per-duration-bucket EER (single embeddings) ==');
  for (const bucket of DURATION_BUCKETS) {
    const inBucket = samples.filter((s) => bucketFor(s.durationSec) === bucket);
    console.log(`\nbucket ${bucket} (${inBucket.length} clips):`);
    const bucketed = pairwiseScores(inBucket);
    printEerSweep(bucketed.genuine, bucketed.impostor);
  }

  printBucketedDistributions('N-embedding centroid cosine', samples, centroidTrials);

  console.log('\n== margin (best - second scoring person), split by whether the top match was correct ==');
  const margins = marginTrials(samples);
  printDistributionSummary('genuine (top match correct)', margins.genuine);
  printDistributionSummary('impostor (top match WRONG)', margins.impostor);
}

// Guarded so `calibration-metrics.test.ts` can import the pure scoring
// helpers from `./calibration-metrics.js` without triggering this script's
// own `main()` as an import-time side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('calibrate-speaker-threshold failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
