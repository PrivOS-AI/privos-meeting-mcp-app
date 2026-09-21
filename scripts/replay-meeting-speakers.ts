#!/usr/bin/env -S npx tsx
/**
 * Replays one calibration meeting's kept per-part recording + its OWN logged
 * `chunk.spans` through the REAL `MeetingSessionRegistry`/`speaker-matcher.ts`
 * code, under a GIVEN (injected) `SpeakerThresholds` config — so calibration
 * and every later gate/mode-switch flip is judged against the exact
 * production decision logic, never a re-implemented sweep. Prints merges,
 * final speaker count, and per-turn attribution accuracy against
 * `labels.json` (same file format `extract-calibration-slices.ts` reads).
 *
 * Usage:
 *   npx tsx scripts/replay-meeting-speakers.ts \
 *     --parts ./meeting/parts \
 *     --diagnostics ./meeting/speaker-diagnostics.jsonl \
 *     --labels ./meeting/labels.json \
 *     [--config ./meeting/candidate-config.json] \
 *     [--profiles ./meeting/profiles.json] \
 *     [--cache ./meeting/.replay-embedding-cache] \
 *     [--out-json ./meeting/replay-result.json]
 *
 *   npx tsx scripts/replay-meeting-speakers.ts --purge-cache ./meeting/.replay-embedding-cache
 *
 * Inputs:
 *  - `--parts <dir>`: the meeting's KEPT per-part uploads (only present when
 *    the job ran with `keepPartsForCalibration` — see `env.ts`), downloaded
 *    from the meeting's Files folder AS-IS (original names,
 *    `audio.part-NNNN-<meetingId8>.webm`) into one local directory; this
 *    script scans for that exact naming and sorts by the embedded seq. The
 *    CONCATENATED `audio.webm` alone cannot substitute — replay needs each
 *    part decoded separately, with the same 8s overlap ring the live chunk
 *    worker used, to reproduce production's per-chunk decisions.
 *  - `--diagnostics <path>`: `speaker-diagnostics.jsonl` (room or node copy —
 *    both carry `chunk` and `observe` events' full field set). `chunk` events
 *    supply the per-seq `spans`/`clientDurationMs` this script re-feeds into
 *    the registry (the SAME diarization turns production saw); `observe`
 *    events supply the ORIGINAL run's `targetId` per turn, used only to
 *    resolve `labels.json`'s ground truth (replay creates its OWN, unrelated
 *    session-speaker ids every run, so accuracy is judged by re-joining on
 *    `label:startMs`, never by comparing raw ids).
 *  - `--labels <path>`: same `CalibrationLabels` shape `extract-calibration-slices.ts`
 *    reads (`speakers`/`excludeTurns`/`overrideTurns`, keyed by the ORIGINAL
 *    run's `targetId`). Optional — omit to still see merges/speaker-count
 *    without an accuracy report.
 *  - `--config <path>`: a JSON object with ANY SUBSET of {@link SpeakerThresholds}'s
 *    fields (e.g. `{"sessionMergeThreshold": 0.7}` to flip ONE gate) — missing
 *    fields fall back to `configFromEnv()` (today's-behaviour default).
 *    Omit `--config` entirely to replay against the current `.env` verbatim
 *    (a useful baseline run before flipping anything).
 *  - `--profiles <path>` (optional, HIGHLY SENSITIVE — raw voiceprint vectors):
 *    a JSON array `[{ "id", "displayName", "embeddings": [{ "vector": number[] }] }]`
 *    exported ONCE, on the node, from `speaker_profiles` for this replay only.
 *    Never sent anywhere; never leaves the node. Omitted entirely by default —
 *    the session-registry/matcher thresholds this phase calibrates are fully
 *    exercised without it; only the profile-naming side-effect on merge
 *    identity guards is skipped.
 *  - `--cache <dir>` (optional, defaults next to `--diagnostics`): embeddings
 *    cached by `(meetingId, label, startMs)` so a SWEEP of many `--config`
 *    values against the SAME meeting does not re-embed ~900 turns per run.
 *    Also biometric material (raw vectors) — purge explicitly with
 *    `--purge-cache <dir>` once the sweep for a meeting is done; this
 *    script's own per-run scratch (fixed-webm/decoded-wav work files) is
 *    deleted unconditionally in its own `finally` regardless, since those are
 *    pure ephemeral decode intermediates, never a deliberate output.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { env } from '../src/server/env.js';
import { decodeToWav16k, readWavPcm } from '../src/server/media/decode-audio.js';
import { concatPcm } from '../src/server/speaker/pcm-utils.js';
import { computeEmbedding } from '../src/server/speaker/embedding-extractor.js';
import { hasRealEnergy, isWithinPartWindow, type ChunkSegment } from '../src/server/tools/span-validation.js';
import { extractWebmInitSegment } from '../src/server/live-speakers/webm-init-segment.js';
import { MeetingSessionRegistry, type SpeakerRegistryFact } from '../src/server/speaker/session-speaker-registry.js';
import { configFromEnv, type SpeakerThresholds } from '../src/server/speaker/speaker-thresholds.js';
import { acceptProfileMatch, matchSpeaker } from '../src/server/speaker/speaker-matcher.js';
import type { SpeakerProfile } from '../src/server/speaker/profile-store.js';
import { readCalibrationLabels, type CalibrationLabels } from './calibration-labels.js';
import { computeAttributionReport, parsePartSeq, resolveTruePersonByTurnKey, type AttributionReport, type ObserveEventLike } from './replay-attribution.js';

interface ChunkEventLike {
  type: 'chunk';
  seq: number;
  spans: { label: string; startMs: number; endMs: number; final: boolean }[];
  clientDurationMs: number;
}

function parseArgs(argv: readonly string[]): Record<string, string> {
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

async function readDiagnosticsEvents(diagnosticsPath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(diagnosticsPath, 'utf8');
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed as Record<string, unknown>);
    } catch {
      // tolerate a truncated/corrupt line, same as speaker-diagnostics-log.ts's own reader.
    }
  }
  return events;
}

async function readLabels(labelsPath?: string): Promise<CalibrationLabels | undefined> {
  return labelsPath ? readCalibrationLabels(labelsPath) : undefined;
}

async function readThresholds(configPath?: string): Promise<SpeakerThresholds> {
  const base = configFromEnv();
  if (!configPath) return base;
  const raw = await readFile(configPath, 'utf8');
  const overrides = JSON.parse(raw) as Partial<SpeakerThresholds>;
  return { ...base, ...overrides };
}

async function readProfiles(profilesPath?: string): Promise<SpeakerProfile[]> {
  if (!profilesPath) return [];
  const raw = await readFile(profilesPath, 'utf8');
  const parsed = JSON.parse(raw) as { id: string; displayName: string; embeddings: { vector: number[] }[] }[];
  return parsed.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    colorKey: 'blue',
    createdByUserId: 'replay',
    embeddings: p.embeddings.map((e) => ({
      vector: Float32Array.from(e.vector),
      meetingId: 'replay',
      durationSec: 0,
      createdAt: new Date(0).toISOString(),
      speakerKey: 'replay',
    })),
    centroid: null,
    dim: p.embeddings[0]?.vector.length ?? 0,
    sampleCount: p.embeddings.length,
  }));
}

async function listPartFiles(partsDir: string): Promise<Map<number, string>> {
  const entries = await readdir(partsDir);
  const map = new Map<number, string>();
  for (const name of entries) {
    const seq = parsePartSeq(name);
    if (seq === null) continue;
    map.set(seq, path.join(partsDir, name));
  }
  if (map.size === 0) {
    throw new Error(`No files matching "audio.part-NNNN-<meetingId8>.webm" found in "${partsDir}" — download the meeting's KEPT parts as-is (original names).`);
  }
  return map;
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

async function cachedEmbedding(cacheDir: string, meetingId: string, label: string, startMs: number, slice: Float32Array): Promise<Float32Array> {
  const cacheFile = path.join(cacheDir, `${sanitizeForFilename(meetingId)}__${sanitizeForFilename(label)}__${startMs}.f32`);
  const cached = await readFile(cacheFile).catch(() => null);
  if (cached) return new Float32Array(cached.buffer, cached.byteOffset, cached.byteLength / 4);
  const embedding = await computeEmbedding(slice);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
  return embedding;
}

interface MergePrintable {
  winnerId: string;
  loserId: string;
  cos: number;
  streak: number;
  winnerSpeechSec: number;
  loserSpeechSec: number;
}

async function replay(opts: {
  partsDir: string;
  diagnosticsPath: string;
  labelsPath?: string;
  configPath?: string;
  profilesPath?: string;
  cacheDir: string;
  outJsonPath?: string;
}): Promise<void> {
  const events = await readDiagnosticsEvents(opts.diagnosticsPath);
  const meetingIdFromLog = events.find((e) => typeof e.meetingId === 'string')?.meetingId as string | undefined;
  const meetingId = meetingIdFromLog ?? 'replay-meeting';

  const chunkEvents = (events.filter((e) => e.type === 'chunk') as unknown as ChunkEventLike[]).sort((a, b) => a.seq - b.seq);
  const observeEvents = events.filter((e) => e.type === 'observe') as unknown as ObserveEventLike[];
  if (chunkEvents.length === 0) throw new Error(`No "chunk" events found in "${opts.diagnosticsPath}" — nothing to replay.`);

  const labels = await readLabels(opts.labelsPath);
  const thresholds = await readThresholds(opts.configPath);
  const profiles = await readProfiles(opts.profilesPath);
  const partFiles = await listPartFiles(opts.partsDir);

  console.log(`Replaying meeting "${meetingId}": ${chunkEvents.length} chunk(s), ${partFiles.size} kept part(s), ${profiles.length} profile(s) loaded.`);

  const scratchDir = path.join(os.tmpdir(), `replay-${randomBytes(6).toString('hex')}`);
  await mkdir(scratchDir, { recursive: true });
  await mkdir(opts.cacheDir, { recursive: true });

  const registry = new MeetingSessionRegistry(meetingId, thresholds);
  const merges: MergePrintable[] = [];
  const replayTargetByTurnKey = new Map<string, string>();
  let skippedMissingParts = 0;

  try {
    let webmInit: Buffer | null = null;

    for (const chunkEvent of chunkEvents) {
      const seq = chunkEvent.seq;
      const partPath = partFiles.get(seq);
      if (!partPath) {
        console.warn(`  seq=${seq}: no kept part file found — skipping (clock still advances, matching a dropped-chunk contract).`);
        registry.markDiscontinuity(seq);
        registry.noteDecoded(seq, chunkEvent.clientDurationMs / 1000);
        skippedMissingParts++;
        continue;
      }

      try {
        let decodeInput = partPath;
        if (seq === 0) {
          webmInit = extractWebmInitSegment(await readFile(partPath));
        } else {
          if (!webmInit) {
            const part0 = partFiles.get(0);
            if (part0) webmInit = extractWebmInitSegment(await readFile(part0));
          }
          if (webmInit) {
            const fixedPath = path.join(scratchDir, `part-${seq}-fixed.webm`);
            await writeFile(fixedPath, Buffer.concat([webmInit, await readFile(partPath)]));
            decodeInput = fixedPath;
          }
        }

        const wavPath = path.join(scratchDir, `chunk-${seq}.wav`);
        const controller = new AbortController();
        const decoded = await decodeToWav16k(decodeInput, wavPath, controller.signal);
        const chunkPcm = await readWavPcm(wavPath, 0, decoded.durationSec);
        const overlap = registry.ringTake();
        const pcm = concatPcm([overlap, chunkPcm]);
        const partStartMs = registry.decodedSecBefore(seq) * 1000;
        const chunkStartSec = partStartMs / 1000 - overlap.length / 16000;

        const handleSegment = async (seg: ChunkSegment, checkWindow: boolean): Promise<void> => {
          if (registry.alreadyProcessed(seg)) return;
          if (checkWindow && !isWithinPartWindow(seg, partStartMs, chunkEvent.clientDurationMs)) return;

          const fromSec = seg.startMs / 1000 - chunkStartSec;
          const toSec = seg.endMs / 1000 - chunkStartSec;
          if (toSec > pcm.length / 16000) {
            registry.defer(seg);
            return;
          }
          if (fromSec < 0 || toSec - fromSec < thresholds.minSegmentSec) return;

          const fromSample = Math.max(0, Math.round(fromSec * 16000));
          const toSample = Math.min(pcm.length, Math.round(toSec * 16000));
          const slice = pcm.subarray(fromSample, toSample);
          if (!hasRealEnergy(slice)) return;

          const embedding = await cachedEmbedding(opts.cacheDir, meetingId, seg.speaker, seg.startMs, slice);
          registry.observe(seg.speaker, embedding, toSec - fromSec, seg, (fact: SpeakerRegistryFact) => {
            if (fact.kind === 'merge' && !fact.blockedBy) {
              merges.push({ winnerId: fact.winnerId, loserId: fact.loserId, cos: fact.cos, streak: fact.streak, winnerSpeechSec: fact.winnerSpeechSec, loserSpeechSec: fact.loserSpeechSec });
            }
            if (fact.kind === 'observe') replayTargetByTurnKey.set(`${fact.label}:${fact.startMs}`, fact.targetId);
          });
        };

        for (const seg of registry.takeDeferred()) await handleSegment(seg, false);
        for (const span of chunkEvent.spans) await handleSegment({ speaker: span.label, startMs: span.startMs, endMs: span.endMs, final: span.final }, true);

        const tailStart = Math.max(0, pcm.length - env.liveChunkOverlapSec * 16000);
        registry.ringSet(pcm.subarray(tailStart));

        if (profiles.length > 0) {
          for (const sessionSpeakerId of registry.candidatesForProfileMatch()) {
            const centroid = registry.centroidFor(sessionSpeakerId);
            if (!centroid) continue;
            const match = matchSpeaker(centroid, profiles);
            const accepted = acceptProfileMatch(match, thresholds);
            registry.applyProfileMatch(sessionSpeakerId, accepted ?? { confidence: 0 });
          }
        }

        registry.settledTurns(); // drained, never persisted — this script does not write live-turns.json.
      } catch (error) {
        console.warn(`  seq=${seq}: chunk processing error (matching production's "never throw past this" contract) —`, error instanceof Error ? error.message : error);
        registry.markDiscontinuity(seq);
      } finally {
        registry.noteDecoded(seq, chunkEvent.clientDurationMs / 1000);
      }
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const activeSpeakers = registry.snapshot().filter((s) => !s.mergedInto);
  console.log(`\nReplay finished: ${activeSpeakers.length} active session speaker(s) (${skippedMissingParts} chunk(s) skipped for a missing part file).`);

  console.log(`\nMerges (${merges.length}):`);
  for (const m of merges) {
    console.log(`  ${m.loserId.slice(0, 8)} -> ${m.winnerId.slice(0, 8)} (cos=${m.cos.toFixed(3)}, streak=${m.streak}, speech ${m.loserSpeechSec.toFixed(1)}s -> ${m.winnerSpeechSec.toFixed(1)}s)`);
  }

  let accuracyReport: AttributionReport | undefined;
  if (labels) {
    const truePersonByTurnKey = resolveTruePersonByTurnKey(observeEvents, labels);
    accuracyReport = computeAttributionReport(replayTargetByTurnKey, truePersonByTurnKey);
    const { correctTurns, totalLabeledTurns, falseMergedPeople, falseSplitPeople } = accuracyReport;

    console.log(`\nAttribution vs labels.json: ${correctTurns}/${totalLabeledTurns} turns correct (${(accuracyReport.accuracy * 100).toFixed(1)}%).`);
    if (falseMergedPeople.length > 0) console.log(`  FALSE MERGES: ${falseMergedPeople.map((people) => people.join(' + ')).join(', ')}`);
    if (falseSplitPeople.length > 0) console.log(`  FALSE SPLITS: ${falseSplitPeople.join(', ')}`);
    if (falseMergedPeople.length === 0 && falseSplitPeople.length === 0) console.log('  0 false merges, 0 false splits.');
  } else {
    console.log('\n(no --labels given — skipped the attribution report)');
  }

  if (opts.outJsonPath) {
    const summary = {
      meetingId,
      thresholds,
      activeSpeakerCount: activeSpeakers.length,
      mergeCount: merges.length,
      skippedMissingParts,
      ...(accuracyReport ? { accuracy: accuracyReport } : {}),
    };
    await writeFile(opts.outJsonPath, JSON.stringify(summary, null, 2));
    console.log(`\nWrote machine-readable summary to "${opts.outJsonPath}".`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args['purge-cache']) {
    console.log(`Purging embedding cache "${args['purge-cache']}"...`);
    await rm(args['purge-cache'], { recursive: true, force: true });
    console.log('Done.');
    return;
  }

  if (!args.parts || !args.diagnostics) {
    console.error('Usage: npx tsx scripts/replay-meeting-speakers.ts --parts <dir> --diagnostics <path> [--labels <path>] [--config <path>] [--profiles <path>] [--cache <dir>] [--out-json <path>]');
    console.error('   or: npx tsx scripts/replay-meeting-speakers.ts --purge-cache <dir>');
    process.exitCode = 1;
    return;
  }

  const cacheDir = args.cache ? path.resolve(args.cache) : path.join(path.dirname(path.resolve(args.diagnostics)), '.replay-embedding-cache');

  await replay({
    partsDir: path.resolve(args.parts),
    diagnosticsPath: path.resolve(args.diagnostics),
    labelsPath: args.labels ? path.resolve(args.labels) : undefined,
    configPath: args.config ? path.resolve(args.config) : undefined,
    profilesPath: args.profiles ? path.resolve(args.profiles) : undefined,
    cacheDir,
    outJsonPath: args['out-json'] ? path.resolve(args['out-json']) : undefined,
  });
}

// Guarded so `replay-meeting-speakers.test.ts` can import this module's pure
// helpers without also running `main()` as an import-time side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('replay-meeting-speakers failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
