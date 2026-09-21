/**
 * The per-`(meetingId, seq)` live chunk worker (plan.md's Architecture
 * pseudocode). Runs behind `keyed-serial-queue.ts` (one at a time per
 * meeting, parallel across meetings): downloads the just-uploaded part,
 * decodes it, cuts PCM per turn, embeds, folds each observation into the
 * meeting's `session-speaker-registry.ts`, tries to match sticky speakers
 * against `speaker_profiles`, appends settled turns to `live-turns.json`, and
 * (at most once per part) upserts `meeting_speakers`.
 *
 * Three safety invariants enforced here, matching plan.md's three rules:
 * (1) every span is re-validated against the server-tracked part window and
 * real audio energy before it ever reaches an embedding; (2) a turn crossing
 * a chunk boundary is DEFERRED, never dropped, and embedded exactly once
 * (dedupe by `speaker+startMs`); (3) `noteDecoded` runs in `finally` for
 * EVERY chunk (success, failure, or backlog-drop) so one bad chunk never
 * skews the clock for every chunk after it (S2-08).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { cosineSimilarity } from '../../shared/cosine.js';
import type { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { env } from '../env.js';
import { decodeToWav16k, readWavPcm } from '../media/decode-audio.js';
import { appendLiveTurns, type LiveTurnSpan } from '../media/live-turns-store.js';
import { dataDir } from '../paths.js';
import { computeEmbedding } from '../speaker/embedding-extractor.js';
import { concatPcm } from '../speaker/pcm-utils.js';
import * as profileStore from '../speaker/profile-store.js';
import type { SpeakerProfile } from '../speaker/profile-store.js';
import { readMatchThreshold } from '../speaker/resolve-speakers.js';
import { sessionRegistries, type MeetingSessionRegistry, type SpeakerRegistryFact } from '../speaker/session-speaker-registry.js';
import { append, flush, type DiagnosticEvent } from '../speaker/speaker-diagnostics-log.js';
import { matchSpeaker } from '../speaker/speaker-matcher.js';
import { KeyedSerialQueue } from '../jobs/keyed-serial-queue.js';
import { ensureRegistry, upsertAll } from './live-speaker-repository.js';
import { downloadPartBySeq } from './part-window.js';
import { extractWebmInitSegment } from './webm-init-segment.js';
import { hasRealEnergy, isWithinPartWindow, validatePartStamp, type ChunkSegment } from '../tools/span-validation.js';

export interface ChunkReadyRequest {
  roomId: string;
  meetingId: string;
  seq: number;
  durationMs: number;
  /** Absolute part-boundary stamp from a NEW client — `undefined` for an older tab across a deploy, which falls back to the registry's cumulative clock (see `processChunk`). */
  partStartMs?: number;
  /** Server wall-clock `Date.now()` when `meeting_chunk_ready` was received — diagnostics only (`uploadLagMs`), set by `chunk-ready-tool.ts`; defaults to "now" so hand-built test requests need not set it. */
  arrivedAtMs?: number;
  segments: ChunkSegment[];
}

export interface ChunkWorkerCtx {
  db: AppDbBotClient;
  hub: RoomBoundHubClient;
  folderId: string;
}

/** `s0:1` / `s0:1@2` -> `0` — the realtime session index namespaced into the label (P2). Defaults to 0 on an unexpected shape rather than throwing (cosmetic field only, never blocks processing). */
function sessionIndexFromLabel(label: string): number {
  const match = /^s(\d+):/.exec(label);
  return match ? Number(match[1]) : 0;
}

// ---- workspace-global speaker_profiles cache (shared across meetings, TTL 10min — risk table) ----
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;
let profileCache: { at: number; profiles: SpeakerProfile[] } | null = null;

async function cachedProfiles(db: AppDbBotClient): Promise<SpeakerProfile[]> {
  if (profileCache && Date.now() - profileCache.at < PROFILE_CACHE_TTL_MS) return profileCache.profiles;
  const profiles = await profileStore.listProfiles(db);
  profileCache = { at: Date.now(), profiles };
  return profiles;
}

/** Drops the cached `speaker_profiles` list — call after any enrolment (e.g. a live one-shot `user-live` enrol) so the very next live match sees the new vector instead of waiting up to `PROFILE_CACHE_TTL_MS`. */
export function invalidateProfileCache(): void {
  profileCache = null;
}

/** Test-only: forces the next `cachedProfiles` call to re-query. */
export function resetProfileCacheForTests(): void {
  invalidateProfileCache();
}

async function matchPendingAgainstProfiles(db: AppDbBotClient, registry: MeetingSessionRegistry): Promise<void> {
  const candidateIds = registry.candidatesForProfileMatch();
  if (candidateIds.length === 0) return;
  const [threshold, profiles] = await Promise.all([readMatchThreshold(db), cachedProfiles(db)]);
  for (const sessionSpeakerId of candidateIds) {
    const centroid = registry.centroidFor(sessionSpeakerId);
    if (!centroid) continue;
    const match = matchSpeaker(centroid, profiles, threshold);
    const attempt = registry.applyProfileMatch(sessionSpeakerId, match);
    append(registry, {
      t: Date.now(),
      meetingId: registry.meetingId,
      type: 'profile-match',
      sessionSpeakerId,
      attempt,
      best: match.bestProfileId ? { profile: match.bestProfileId, cos: match.confidence } : null,
      second: match.runnerUpProfileId ? { profile: match.runnerUpProfileId, cos: match.runnerUpConfidence } : null,
      threshold,
      accepted: Boolean(match.profileId),
    });
  }
}

/** `ObserveFact`/`MergeFact` (registry-internal, opaque to diagnostics) -> the full timestamped `DiagnosticEvent` this chunk logs. */
function toDiagnosticEvent(meetingId: string, seq: number, fact: SpeakerRegistryFact): DiagnosticEvent {
  const t = Date.now();
  if (fact.kind === 'observe') {
    return {
      t,
      meetingId,
      type: 'observe',
      seq,
      label: fact.label,
      startMs: fact.startMs,
      endMs: fact.endMs,
      durSec: fact.durSec,
      final: fact.final,
      targetId: fact.targetId,
      decisionScore: fact.decisionScore,
      scores: fact.scores,
      sticky: fact.sticky,
      action: fact.action,
    };
  }
  return {
    t,
    meetingId,
    type: 'merge',
    winnerId: fact.winnerId,
    loserId: fact.loserId,
    cos: fact.cos,
    winnerSpeechSec: fact.winnerSpeechSec,
    loserSpeechSec: fact.loserSpeechSec,
    winnerNamed: fact.winnerNamed,
    loserNamed: fact.loserNamed,
  };
}

/** Pairwise cosine between every active (non-merged) session speaker's centroid — once per chunk, diagnostics only. */
function buildCentroidsEvent(meetingId: string, registry: MeetingSessionRegistry): DiagnosticEvent {
  const active = registry.snapshot().filter((s) => !s.mergedInto);
  const pairs: { aId: string; bId: string; cos: number }[] = [];
  for (let i = 0; i < active.length; i++) {
    const a = registry.centroidFor(active[i].sessionSpeakerId);
    if (!a) continue;
    for (let j = i + 1; j < active.length; j++) {
      const b = registry.centroidFor(active[j].sessionSpeakerId);
      if (!b || a.length !== b.length) continue;
      pairs.push({ aId: active[i].sessionSpeakerId, bId: active[j].sessionSpeakerId, cos: cosineSimilarity(a, b) });
    }
  }
  return { t: Date.now(), meetingId, type: 'centroids', pairs };
}

/**
 * Turns the just-downloaded part into a standalone-decodable WebM path. Part 0
 * carries the WebM header, so it decodes as-is and its init segment is cached
 * for the meeting. Parts `seq >= 1` are bare Opus clusters — the cached init
 * segment is prepended (re-fetching part 0 once if the cache was lost to a
 * restart) so ffmpeg can decode them (see `webm-init-segment.ts`).
 */
async function resolveDecodableInput(
  ctx: ChunkWorkerCtx,
  req: ChunkReadyRequest,
  registry: MeetingSessionRegistry,
  tmpDir: string,
  partPath: string,
  signal: AbortSignal,
): Promise<string> {
  if (req.seq === 0) {
    registry.setWebmInitSegment(extractWebmInitSegment(await readFile(partPath)));
    return partPath;
  }

  let init = registry.getWebmInitSegment();
  if (!init) {
    // Cache lost (server restarted mid-meeting) — re-fetch part 0 for its header only.
    const part0Path = path.join(tmpDir, 'part0.webm');
    await downloadPartBySeq(ctx.hub, req.roomId, ctx.folderId, req.meetingId, 0, part0Path, signal);
    init = extractWebmInitSegment(await readFile(part0Path));
    registry.setWebmInitSegment(init);
  }

  const fixedPath = path.join(tmpDir, 'part-fixed.webm');
  await writeFile(fixedPath, Buffer.concat([init, await readFile(partPath)]));
  return fixedPath;
}

/**
 * The actual per-chunk work (plan.md's `onChunkReady` pseudocode). NEVER
 * throws past its own `catch` — any failure is logged and the registry is
 * marked discontinuous; the caller (the queue) treats this as "done", not
 * "errored", because a chunk failing must never break the recording/caption
 * pipeline (plan.md § Non-functional).
 */
export async function processChunk(ctx: ChunkWorkerCtx, req: ChunkReadyRequest, signal: AbortSignal): Promise<void> {
  const registry = await ensureRegistry(ctx.db, req.meetingId);
  const tmpDir = path.join(dataDir, 'tmp', `live-${req.meetingId}-${req.seq}-${randomUUID()}`);

  // A seq the server never saw at all (not a queue-backlog drop, which already
  // marks `discontinuous` itself — this is a client-side gap, e.g. the upload
  // queue's own cap dropped a part while recording continued). With absolute
  // per-part stamps the parts AFTER the gap stay aligned on their own, but the
  // overlap ring spanning the missing part is no longer trustworthy, so this
  // is treated exactly like any other discontinuity: ring cleared, degraded
  // raised, logged before anything below can throw.
  const expectedSeq = registry.nextExpectedSeq();
  if (req.seq > expectedSeq) {
    append(registry, { t: Date.now(), meetingId: req.meetingId, type: 'gap', fromSeq: expectedSeq, toSeq: req.seq });
    registry.markDiscontinuity(req.seq);
  }

  let chunkOk = true;
  let decodedDurationSec = 0;
  let overlapSec = 0;
  let deferredCount = 0;
  /** Set only once the client's stamp validates — an estimate of network+queue lag, never derived from a rejected/absent stamp. */
  let uploadLagMs: number | null = null;
  const skipped = { window: 0, silence: 0, short: 0 };

  try {
    // A NEW client's absolute stamp is validated BEFORE anything is
    // downloaded/decoded: finite/non-negative, monotonic, within tolerance of
    // where the previous part should have ended, and not an implausible
    // duration. A violation skips this whole chunk (never sliced from a
    // guessed position) exactly like a decode failure below — `chunkOk=false`,
    // `markDiscontinuity`, logged via the `finally` block's `chunk` event. An
    // absent `partStartMs` (older client tab across a deploy) skips this
    // check entirely and keeps today's cumulative-clock behaviour.
    if (req.partStartMs !== undefined) {
      const violation = validatePartStamp(
        { seq: req.seq, partStartMs: req.partStartMs, durationMs: req.durationMs },
        registry.lastPartStampForValidation(),
      );
      if (violation) throw new AppError(`Rejected client part stamp — ${violation}`);
      registry.noteValidPartStamp(req.seq, req.partStartMs, req.durationMs);
      uploadLagMs = registry.estimateUploadLagMs(req.arrivedAtMs ?? Date.now(), req.partStartMs, req.durationMs);
    }

    await mkdir(tmpDir, { recursive: true });
    if (signal.aborted) throw new AppError('Chunk was cancelled before downloading the recording part.');

    const partPath = path.join(tmpDir, 'part.webm');
    await downloadPartBySeq(ctx.hub, req.roomId, ctx.folderId, req.meetingId, req.seq, partPath, signal);
    const decodeInput = await resolveDecodableInput(ctx, req, registry, tmpDir, partPath, signal);

    const wavPath = path.join(tmpDir, 'chunk.wav');
    const decoded = await decodeToWav16k(decodeInput, wavPath, signal);
    decodedDurationSec = decoded.durationSec;
    if (signal.aborted) throw new AppError('Chunk was cancelled during decode.');

    const chunkPcm = await readWavPcm(wavPath, 0, decoded.durationSec);
    const overlap = registry.ringTake();
    overlapSec = overlap.length / 16000;
    const pcm = concatPcm([overlap, chunkPcm]);
    // A NEW client's own absolute stamp positions this part directly; an
    // OLDER client (no `partStartMs`) falls back to the registry's cumulative
    // decoded-duration clock, unchanged from before this stamp existed.
    const partStartMs = req.partStartMs ?? registry.decodedSecBefore(req.seq) * 1000;
    const chunkStartSec = partStartMs / 1000 - overlap.length / 16000;

    /**
     * Cuts + embeds one turn against the CURRENT chunk's pcm/window. Deferred
     * turns (retried from a previous chunk) already passed the part-window
     * check back when they were first seen — their own `startMs` legitimately
     * belongs to the PREVIOUS chunk's window, not this one, so re-checking it
     * here against `partStartMs` would wrongly reject them. Only turns fresh
     * off THIS request get that check.
     */
    async function handleSegment(seg: ChunkSegment, checkWindow: boolean): Promise<void> {
      if (signal.aborted) throw new AppError('Chunk was cancelled while processing the turn.');
      if (registry.alreadyProcessed(seg)) return;

      if (checkWindow && !isWithinPartWindow(seg, partStartMs, req.durationMs)) {
        console.warn('[chunk-worker] span outside part window — skipping (security event).', {
          meetingId: req.meetingId,
          seq: req.seq,
          speaker: seg.speaker,
          startMs: seg.startMs,
        });
        skipped.window++;
        return;
      }

      const fromSec = seg.startMs / 1000 - chunkStartSec;
      const toSec = seg.endMs / 1000 - chunkStartSec;
      if (toSec > pcm.length / 16000) {
        registry.defer(seg); // turn straddling a part boundary (S2-03) — retried against the next chunk's extended window.
        deferredCount++;
        return;
      }
      if (fromSec < 0 || toSec - fromSec < env.speakerMinSegmentSec) {
        skipped.short++;
        return;
      }

      const fromSample = Math.max(0, Math.round(fromSec * 16000));
      const toSample = Math.min(pcm.length, Math.round(toSec * 16000));
      const slice = pcm.subarray(fromSample, toSample);
      if (!hasRealEnergy(slice)) {
        console.warn('[chunk-worker] span points into silence — skipping (security event).', { meetingId: req.meetingId, seq: req.seq, speaker: seg.speaker });
        skipped.silence++;
        return;
      }

      const embedding = await computeEmbedding(slice);
      registry.observe(seg.speaker, embedding, toSec - fromSec, seg, (fact) => append(registry, toDiagnosticEvent(req.meetingId, req.seq, fact)));
    }

    for (const seg of registry.takeDeferred()) await handleSegment(seg, false);
    for (const seg of req.segments) await handleSegment(seg, true);

    const tailStart = Math.max(0, pcm.length - env.liveChunkOverlapSec * 16000);
    registry.ringSet(pcm.subarray(tailStart));

    await matchPendingAgainstProfiles(ctx.db, registry);
    append(registry, buildCentroidsEvent(req.meetingId, registry));

    const settled = registry.settledTurns();
    if (settled.length > 0) {
      const spans: LiveTurnSpan[] = settled.map((t) => ({
        id: `${t.sessionSpeakerId}:${t.startMs}`,
        speakerKey: t.sessionSpeakerId,
        startMs: t.startMs,
        endMs: t.endMs,
        text: '',
        sessionIndex: sessionIndexFromLabel(t.sonioxLabel),
      }));
      await appendLiveTurns(ctx.hub, req.roomId, ctx.folderId, spans, signal);
    }

    if (registry.snapshotChanged()) {
      await upsertAll(ctx.db, req.meetingId, registry);
    }
  } catch (error) {
    console.error('[chunk-worker] chunk processing error — skipping, the clock still advances for the next chunk.', {
      meetingId: req.meetingId,
      seq: req.seq,
      error: error instanceof Error ? error.message : String(error),
    });
    registry.markDiscontinuity(req.seq);
    chunkOk = false;
  } finally {
    // ALWAYS runs — the clock advances by the client-measured durationMs no
    // matter what happened above, so a single bad chunk never skews every
    // chunk after it (S2-08).
    registry.noteDecoded(req.seq, req.durationMs / 1000);

    // `captureDriftMs`: this part's own wall span (the client's emit-stamped
    // `durationMs`) minus what actually decoded — per part, never cumulative.
    const captureDriftMs = req.durationMs - decodedDurationSec * 1000;
    append(registry, {
      t: Date.now(),
      meetingId: req.meetingId,
      type: 'chunk',
      seq: req.seq,
      spans: req.segments.map((s) => ({ label: s.speaker, startMs: s.startMs, endMs: s.endMs, final: s.final })),
      clientDurationMs: req.durationMs,
      decodedDurationSec,
      // `uploadLagMs`: server arrival time vs the client's emit stamp
      // (`registry.estimateUploadLagMs`) once a validated `partStartMs`
      // establishes the meeting's wall-clock anchor; for an older client (no
      // `partStartMs`) or a rejected stamp, falls back to the same
      // duration-vs-decoded proxy `captureDriftMs` uses.
      uploadLagMs: uploadLagMs ?? captureDriftMs,
      captureDriftMs,
      overlapSec,
      deferredCount,
      skipped,
      ok: chunkOk,
    });
    await flush(registry);

    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * One process-wide queue, keyed by `meetingId`, shared by BOTH the chunk
 * worker AND `speaker_resolve` (via {@link runOnMeetingQueue}) — the tool's
 * registry mutation + row write must never interleave with a chunk's own
 * `upsertAll` for the same meeting (plan.md red-team finding #5: "no
 * interleaving"). `onDropped` fires synchronously from `enqueue` (it cannot
 * await `ensureRegistry`'s possible DB rebuild) — a CHUNK dropped from the
 * backlog before it ever ran had no `meeting_speakers` write pending for it
 * either way, so touching the in-memory store directly here (no DB rebuild)
 * is correct: there is nothing to rebuild FROM yet. It still advances that
 * meeting's clock and flags `degraded`, same contract as a chunk that ran and
 * failed (S2-08). A dropped `resolve` work item has no clock to advance —
 * `runOnMeetingQueue` surfaces the drop as a rejected promise instead.
 */
type QueuedWork = { kind: 'chunk'; ctx: ChunkWorkerCtx; req: ChunkReadyRequest } | { kind: 'task' };

const chunkQueue = new KeyedSerialQueue<QueuedWork>({
  onDropped: (meetingId, item) => {
    if (item.kind !== 'chunk') return;
    sessionRegistries.get(meetingId).markDropped(item.req.seq, item.req.durationMs);
    console.warn('[chunk-worker] backlog full — dropping chunk, marking degraded.', { meetingId, seq: item.req.seq });
  },
});

/** Enqueues one chunk for processing — fire-and-forget from the tool's perspective (`meeting_chunk_ready` returns `{accepted:true}` immediately). */
export function enqueueChunk(ctx: ChunkWorkerCtx, req: ChunkReadyRequest): void {
  void chunkQueue.enqueue(req.meetingId, { kind: 'chunk', ctx, req }, async (item, signal) => {
    if (item.kind !== 'chunk') return;
    await processChunk(item.ctx, item.req, signal);
  });
}

/**
 * Runs `fn` as a task on the SAME per-meeting serial queue the chunk worker
 * uses, so it can never interleave with that meeting's `processChunk`/
 * `upsertAll` — the primary guard behind `speaker_resolve`'s registry
 * mutation + row write (plan.md § Requirements: "no interleaving"). Rejects
 * if the task is evicted from a full backlog before it ever ran (rare: the
 * cap is "latest + 2" chunks, and a resolve call is quick) rather than
 * silently reporting success for work that never happened.
 */
export function runOnMeetingQueue<T>(meetingId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  return chunkQueue
    .enqueue(meetingId, { kind: 'task' }, async (_item, signal) => {
      try {
        outcome = { ok: true, value: await fn(signal) };
      } catch (error) {
        outcome = { ok: false, error };
      }
    })
    .then(() => {
      if (!outcome) throw new AppError('This meeting is too busy to process that right now — try again in a moment.');
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
}

/** Aborts the meeting's in-flight chunk (if any) and drops its queued backlog, awaiting the actual stop — used by the post-meeting job right before its speaker steps so a still-draining chunk cannot `upsertAll` into rows being reconciled. */
export async function abortMeetingQueue(meetingId: string): Promise<void> {
  await chunkQueue.abort(meetingId);
}

/** Test-only: exposes the queue for backlog/timing assertions. */
export function getChunkQueueForTests(): KeyedSerialQueue<QueuedWork> {
  return chunkQueue;
}
