#!/usr/bin/env -S npx tsx
/**
 * Turns one recorded (calibration) meeting into the `<dir>/<person>/<clip>.wav`
 * layout `scripts/calibrate-speaker-threshold.ts` already consumes, so a real
 * meeting's OWN turns (2-5s, one shared room mic, real colleagues) can be used
 * to calibrate thresholds instead of clean enrolment clips.
 *
 * Usage:
 *   npx tsx scripts/extract-calibration-slices.ts \
 *     --audio ./meeting/audio.webm \
 *     --diagnostics ./meeting/speaker-diagnostics.jsonl \
 *     --labels ./meeting/labels.json \
 *     --out ./meeting/clips
 *
 *   npx tsx scripts/extract-calibration-slices.ts --purge ./meeting/clips
 *
 * Inputs:
 *  - `--audio`: the meeting's recording, any container ffmpeg can decode
 *    (typically `audio.webm`, downloaded from the meeting's Files folder —
 *    only present at all when the job ran with `keepPartsForCalibration`/
 *    `keepAudio`). Decoded once, internally, to 16k mono PCM16 via the SAME
 *    `decodeToWav16k` helper the post-meeting job uses, so turn positions
 *    line up exactly with `observe` events' `startMs`/`endMs` (both are on
 *    the meeting's cumulative-decoded-seconds timeline).
 *  - `--diagnostics`: `speaker-diagnostics.jsonl` (either the room copy from
 *    the meeting's Files folder, or the node-local copy under
 *    `data/diagnostics/` — both carry the `observe` event's full field set).
 *    Only `type:'observe'` lines are read; every other event type is ignored.
 *  - `--labels`: a small hand-written JSON file (see {@link CalibrationLabels})
 *    mapping each `sessionSpeakerId` (an `observe` event's `targetId`) to a
 *    real person name, plus optional per-turn overrides/exclusions for turns
 *    a human listening to the kept audio marks as wrong or overlapped. A
 *    session speaker missing from `speakers` produces NO clips (reported as a
 *    warning, never guessed).
 *  - `--out`: destination root. One subfolder per LABELLED person
 *    (`calibrate-speaker-threshold.ts`'s own required layout), each clip
 *    named by an OPAQUE sequential id — never the raw `sessionSpeakerId` or
 *    `startMs`, so a clip file's name alone never reveals which turn of the
 *    meeting it came from (the `sessionSpeakerId -> person` map is `--labels`,
 *    a SEPARATE operator-held file, never folded into the clip corpus).
 *
 * Biometric handling (node-only tool, run over SSH on hodao, never copied to
 * a laptop): the decoded scratch wav is a pure ephemeral working file, always
 * deleted in this script's own `finally` regardless of outcome. The CLIPS
 * THEMSELVES are this tool's whole output and must persist for the next
 * step (`calibrate-speaker-threshold.ts` / `replay-meeting-speakers.ts` both
 * read them back in a SEPARATE process run) — they are not deleted
 * automatically. Once calibration for a meeting is done, purge them
 * explicitly with `--purge <dir>` (this script's own deletion capability, so
 * the operator never needs a bare `rm -rf` on biometric material) rather than
 * leaving raw voice clips on disk indefinitely.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodeToWav16k, readWavPcm } from '../src/server/media/decode-audio.js';
import { readCalibrationLabels, turnKey } from './calibration-labels.js';
import { encodeWav } from './wav-writer.js';

const SAMPLE_RATE = 16_000;
const MIN_CLIP_SEC = 0.5; // same floor calibrate-speaker-threshold.ts already applies — a shorter clip cannot embed meaningfully.

export interface ObserveTurn {
  targetId: string;
  startMs: number;
  endMs: number;
  durSec: number;
}

function parseArgs(argv: readonly string[]): { audio?: string; diagnostics?: string; labels?: string; out?: string; purge?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        out[key] = value;
        i++;
      }
    }
  }
  return out;
}

export async function readObserveTurns(diagnosticsPath: string): Promise<ObserveTurn[]> {
  const raw = await readFile(diagnosticsPath, 'utf8');
  const turns: ObserveTurn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a truncated/corrupt line — skip, same tolerance as speaker-diagnostics-log.ts's own reader.
    }
    if (!event || typeof event !== 'object') continue;
    const e = event as Record<string, unknown>;
    if (e.type !== 'observe') continue;
    if (typeof e.targetId !== 'string' || typeof e.startMs !== 'number' || typeof e.endMs !== 'number' || typeof e.durSec !== 'number') continue;
    turns.push({ targetId: e.targetId, startMs: e.startMs, endMs: e.endMs, durSec: e.durSec });
  }
  return turns;
}

/** Strips anything that is not safe as a single path segment — a labeller's free-text name still becomes a normal folder name. */
export function sanitizeFolderName(name: string): string {
  const cleaned = name.trim().replace(/[/\\:*?"<>|]+/g, '_');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

async function extract(audioPath: string, diagnosticsPath: string, labelsPath: string, outDir: string): Promise<void> {
  const labels = await readCalibrationLabels(labelsPath);
  const turns = await readObserveTurns(diagnosticsPath);
  console.log(`Read ${turns.length} observe turns from "${diagnosticsPath}".`);

  const excludeSet = new Set(labels.excludeTurns ?? []);
  const overrides = labels.overrideTurns ?? {};
  const unlabeledSpeakers = new Set<string>();
  let excludedCount = 0;
  let tooShortCount = 0;

  const scratchWavPath = path.join(os.tmpdir(), `calib-extract-${randomBytes(6).toString('hex')}.wav`);
  const perPersonCounter = new Map<string, number>();

  try {
    console.log(`Decoding "${audioPath}" to 16k mono wav (scratch, deleted on exit)...`);
    const controller = new AbortController();
    await decodeToWav16k(audioPath, scratchWavPath, controller.signal);

    for (const turn of turns) {
      const key = turnKey(turn.targetId, turn.startMs);
      if (excludeSet.has(key)) {
        excludedCount++;
        continue;
      }
      const person = overrides[key] ?? labels.speakers[turn.targetId];
      if (!person) {
        unlabeledSpeakers.add(turn.targetId);
        continue;
      }
      if (turn.durSec < MIN_CLIP_SEC) {
        tooShortCount++;
        continue;
      }

      const pcm = await readWavPcm(scratchWavPath, turn.startMs / 1000, turn.endMs / 1000);
      if (pcm.length === 0) {
        tooShortCount++;
        continue;
      }

      const folder = sanitizeFolderName(person);
      const personDir = path.join(outDir, folder);
      await mkdir(personDir, { recursive: true });
      const index = (perPersonCounter.get(folder) ?? 0) + 1;
      perPersonCounter.set(folder, index);
      const clipPath = path.join(personDir, `clip-${String(index).padStart(4, '0')}.wav`);
      await writeFile(clipPath, encodeWav(pcm, SAMPLE_RATE));
    }
  } finally {
    await rm(scratchWavPath, { force: true }).catch(() => undefined);
  }

  console.log('\nExtraction summary:');
  for (const [folder, count] of perPersonCounter) console.log(`  ${folder}: ${count} clip(s) -> ${path.join(outDir, folder)}`);
  console.log(`  excluded (labels.excludeTurns): ${excludedCount}`);
  console.log(`  too short (<${MIN_CLIP_SEC}s): ${tooShortCount}`);
  if (unlabeledSpeakers.size > 0) {
    console.warn(`  UNLABELED session speakers (add to labels.json "speakers" to include them): ${[...unlabeledSpeakers].join(', ')}`);
  }
  console.log(`\nNext: npm run calibrate:speaker -- ${outDir}`);
  console.log(`When calibration for this meeting is done, purge the clips: npx tsx scripts/extract-calibration-slices.ts --purge ${outDir}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.purge) {
    console.log(`Purging "${args.purge}"...`);
    await rm(args.purge, { recursive: true, force: true });
    console.log('Done.');
    return;
  }

  if (!args.audio || !args.diagnostics || !args.labels || !args.out) {
    console.error('Usage: npx tsx scripts/extract-calibration-slices.ts --audio <path> --diagnostics <path> --labels <path> --out <dir>');
    console.error('   or: npx tsx scripts/extract-calibration-slices.ts --purge <dir>');
    process.exitCode = 1;
    return;
  }

  await mkdir(args.out, { recursive: true });
  await extract(path.resolve(args.audio), path.resolve(args.diagnostics), path.resolve(args.labels), path.resolve(args.out));
}

// Guarded so `extract-calibration-slices.test.ts` can import this module's
// pure helpers without also running `main()` (and its `process.argv`-driven
// usage/exit-code side effects) as an import-time side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('extract-calibration-slices failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
