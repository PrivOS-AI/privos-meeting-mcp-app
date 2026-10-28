/**
 * How well voiceprints tell people apart, with the app's own embedding model
 * (`computeEmbedding`) and its profile scoring (mean of the top-3 cosines
 * against a profile's stored vectors, `speaker-matcher.ts`).
 *
 *   npx tsx scripts/eval-speakers.ts <dir with speakerN_{a,b}_<lang>_16k.wav>
 *
 * Each speaker is "remembered" from their `a` file (cut into segments, up to
 * 20 vectors like a profile), then every segment of their `b` file (same
 * person, another recording) and of everyone else is scored against every
 * profile — what recognition in a later meeting does. Printed: how often the
 * right person is accepted and a wrong one rejected at the app's threshold,
 * per segment length, clean / quiet / noisy, with and without level
 * normalization before embedding.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

import sherpa from 'sherpa-onnx-node';

import { normalizeLevel } from '../src/server/asr/asr-engine.js';
import { computeEmbedding } from '../src/server/speaker/embedding-extractor.js';

const RATE = 16000;
const dir = process.argv[2];
if (!dir) {
  console.error('usage: eval-speakers.ts <dir>');
  process.exit(2);
}
/** The app's profile-match threshold (room default) and the session-assignment bar. */
const PROFILE_THRESHOLD = Number(process.env.THRESHOLD ?? 0.5);
const PROFILE_CAP = 20;

interface Recording {
  speaker: string;
  take: string;
  samples: Float32Array;
}

const recordings: Recording[] = readdirSync(dir)
  .filter((f) => /^speaker\d+_[ab]_\w+_16k\.wav$/.test(f))
  .map((f) => {
    const [, n, take, lang] = /^speaker(\d+)_([ab])_(\w+)_16k\.wav$/.exec(f)!;
    return { speaker: `${lang}${n}`, take, samples: sherpa.readWave(path.join(dir, f)).samples };
  });

let seed = 3;
function gauss(): number {
  seed = (seed * 16807) % 2147483647;
  const u = seed / 2147483647;
  seed = (seed * 16807) % 2147483647;
  return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos((2 * Math.PI * seed) / 2147483647);
}
const rms = (s: Float32Array) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / Math.max(1, s.length));
const CONDITIONS: Record<string, (s: Float32Array) => Float32Array> = {
  clean: (s) => s,
  'quiet -30dB': (s) => s.map((x) => x * 10 ** (-30 / 20)),
  'noise SNR10': (s) => {
    seed = 11;
    const level = rms(s) / 10 ** (10 / 20);
    return s.map((x) => x + gauss() * level);
  },
};

function segments(samples: Float32Array, seconds: number): Float32Array[] {
  const size = Math.round(seconds * RATE);
  const out: Float32Array[] = [];
  for (let at = 0; at + size <= samples.length; at += size) out.push(samples.subarray(at, at + size));
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

/** `speaker-matcher.ts` scoring: mean of the best 3 cosines against the profile's vectors. */
function profileScore(query: Float32Array, profile: Float32Array[]): number {
  const top = profile.map((v) => cosine(query, v)).sort((a, b) => b - a).slice(0, 3);
  return top.reduce((a, x) => a + x, 0) / top.length;
}

async function embedAll(list: Float32Array[], normalize: boolean): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const s of list) out.push(await computeEmbedding(normalize ? normalizeLevel(s) : s));
  return out;
}

const speakers = [...new Set(recordings.map((r) => r.speaker))];
const withB = speakers.filter((s) => recordings.some((r) => r.speaker === s && r.take === 'b'));
console.log(`speakers: ${speakers.join(', ')}; recognised in a second recording: ${withB.join(', ')}; threshold ${PROFILE_THRESHOLD}`);
console.log('\nsegment  condition     normalize  same-person  accepted   other-person  rejected   margin');

for (const seconds of [1.5, 3, 6]) {
  for (const [condName, cond] of Object.entries(CONDITIONS)) {
    for (const normalize of [false, true]) {
      // Profiles are always enrolled from clean `a` recordings (what a first, well-recorded meeting gives).
      const profiles = new Map<string, Float32Array[]>();
      for (const s of speakers) {
        const a = recordings.find((r) => r.speaker === s && r.take === 'a');
        if (a) profiles.set(s, (await embedAll(segments(a.samples, seconds), normalize)).slice(0, PROFILE_CAP));
      }
      const same: number[] = [];
      const other: number[] = [];
      for (const rec of recordings) {
        const queries = await embedAll(segments(cond(rec.samples), seconds), normalize);
        for (const q of queries) {
          for (const [s, profile] of profiles) {
            if (s === rec.speaker && rec.take === 'a') continue; // never score a profile against the audio it was enrolled from
            (s === rec.speaker ? same : other).push(profileScore(q, profile));
          }
        }
      }
      const accepted = same.filter((x) => x >= PROFILE_THRESHOLD).length / Math.max(1, same.length);
      const rejected = other.filter((x) => x < PROFILE_THRESHOLD).length / Math.max(1, other.length);
      const minSame = Math.min(...same);
      const maxOther = Math.max(...other);
      console.log(
        [
          `${seconds}s`.padEnd(9),
          condName.padEnd(14),
          (normalize ? 'yes' : 'no').padEnd(11),
          `${same.length} (min ${minSame.toFixed(2)})`.padEnd(13),
          `${(accepted * 100).toFixed(0)}%`.padEnd(11),
          `${other.length} (max ${maxOther.toFixed(2)})`.padEnd(14),
          `${(rejected * 100).toFixed(0)}%`.padEnd(11),
          (minSame - maxOther).toFixed(2),
        ].join(''),
      );
    }
  }
}
process.exit(0);
