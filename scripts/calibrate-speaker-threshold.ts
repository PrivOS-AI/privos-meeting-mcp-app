#!/usr/bin/env -S npx tsx
/**
 * `npm run calibrate:speaker -- ./samples` — measures FAR/FRR/EER for the
 * currently configured `SPEAKER_MODEL_PATH` against a labeled sample set, to
 * pick a real `SPEAKER_MATCH_THRESHOLD` instead of the plan's unverified
 * default (plan.md open question #5 — EER/model choice unresolved by design
 * until this script is run against real recordings).
 *
 * Input layout: `<dir>/<person>/<file>.wav` — one subfolder per person, each
 * containing one or more 16kHz mono PCM16 wav clips of ONLY that person
 * speaking (same format `decode-audio.ts` produces: 44-byte canonical
 * header, `pcm_s16le`). Re-encode with
 * `ffmpeg -i in.ext -ac 1 -ar 16000 -c:a pcm_s16le out.wav` first if needed.
 *
 * Method: embeds every clip once, then splits all pairwise cosine scores into
 * "genuine" (same person) and "impostor" (different person) sets. Sweeps
 * threshold 0.30 -> 0.80 in steps of 0.01, printing FAR/FRR per step and the
 * threshold closest to EER (FAR == FRR).
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { cosineSimilarity } from '../src/shared/cosine.js';
import { computeEmbedding } from '../src/server/speaker/embedding-extractor.js';
import { readWavPcm } from '../src/server/media/decode-audio.js';

const WAV_HEADER_BYTES = 44;
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

const THRESHOLD_MIN = 0.3;
const THRESHOLD_MAX = 0.8;
const THRESHOLD_STEP = 0.01;

interface Sample {
  person: string;
  file: string;
  vector: Float32Array;
}

function wavDurationSec(filePath: string): number {
  const { size } = statSync(filePath);
  const pcmBytes = Math.max(0, size - WAV_HEADER_BYTES);
  return pcmBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
}

async function loadSamples(rootDir: string): Promise<Sample[]> {
  const people = readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (people.length === 0) {
    throw new Error(`Không tìm thấy thư mục người nói nào trong "${rootDir}" (kỳ vọng cấu trúc <dir>/<person>/<file>.wav).`);
  }

  const samples: Sample[] = [];
  for (const person of people) {
    const personDir = path.join(rootDir, person.name);
    const files = readdirSync(personDir).filter((f) => f.toLowerCase().endsWith('.wav'));
    for (const file of files) {
      const filePath = path.join(personDir, file);
      const durationSec = wavDurationSec(filePath);
      if (durationSec < 0.5) {
        console.warn(`  bỏ qua "${filePath}" — quá ngắn (${durationSec.toFixed(2)}s).`);
        continue;
      }
      const pcm = await readWavPcm(filePath, 0, durationSec);
      const vector = await computeEmbedding(pcm, SAMPLE_RATE);
      samples.push({ person: person.name, file, vector });
      console.log(`  embedded ${person.name}/${file} (${durationSec.toFixed(1)}s, dim=${vector.length})`);
    }
  }
  return samples;
}

function pairwiseScores(samples: readonly Sample[]): { genuine: number[]; impostor: number[] } {
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

function farAt(impostor: readonly number[], threshold: number): number {
  if (impostor.length === 0) return 0;
  return impostor.filter((s) => s >= threshold).length / impostor.length;
}

function frrAt(genuine: readonly number[], threshold: number): number {
  if (genuine.length === 0) return 0;
  return genuine.filter((s) => s < threshold).length / genuine.length;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Cách dùng: npm run calibrate:speaker -- <thư mục mẫu>');
    process.exitCode = 1;
    return;
  }

  console.log(`Đang trích embedding từ "${dir}"...`);
  let samples: Sample[];
  try {
    samples = await loadSamples(path.resolve(dir));
  } catch (error) {
    console.error('Lỗi:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const byPerson = new Map<string, number>();
  for (const s of samples) byPerson.set(s.person, (byPerson.get(s.person) ?? 0) + 1);
  console.log(`\nĐã embed ${samples.length} mẫu từ ${byPerson.size} người:`, Object.fromEntries(byPerson));

  const { genuine, impostor } = pairwiseScores(samples);
  console.log(`\nCặp cùng người (genuine): ${genuine.length} · Cặp khác người (impostor): ${impostor.length}\n`);

  if (genuine.length === 0 || impostor.length === 0) {
    console.error('Cần ít nhất 2 người và mỗi người ≥2 mẫu để tính FAR/FRR có ý nghĩa.');
    process.exitCode = 1;
    return;
  }

  console.log('threshold  FAR      FRR      |FAR-FRR|');
  let best = { threshold: THRESHOLD_MIN, far: 1, frr: 1, diff: Infinity };
  for (let t = THRESHOLD_MIN; t <= THRESHOLD_MAX + 1e-9; t += THRESHOLD_STEP) {
    const threshold = Math.round(t * 100) / 100;
    const far = farAt(impostor, threshold);
    const frr = frrAt(genuine, threshold);
    const diff = Math.abs(far - frr);
    console.log(`${threshold.toFixed(2)}       ${far.toFixed(3)}    ${frr.toFixed(3)}    ${diff.toFixed(3)}`);
    if (diff < best.diff) best = { threshold, far, frr, diff };
  }

  console.log(`\nNgưỡng đề xuất (gần EER nhất): SPEAKER_MATCH_THRESHOLD=${best.threshold.toFixed(2)} (FAR=${best.far.toFixed(3)}, FRR=${best.frr.toFixed(3)})`);
}

main().catch((error: unknown) => {
  console.error('calibrate-speaker-threshold thất bại:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
