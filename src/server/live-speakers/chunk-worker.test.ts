import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { env } from '../env.js';
import type { AppDbBotClient } from '../hub/app-db-bot-client.js';

const SAMPLE_RATE = 16_000;

/** The full decoded-chunk PCM `readWavPcm` returns for the current test — a constant tone loud enough to pass the RMS gate. */
let currentChunkPcm = new Float32Array(0);
let decodedDurationSec = 60;
let decodeShouldThrow = false;

vi.mock('../media/decode-audio.js', () => ({
  decodeToWav16k: vi.fn(async () => {
    if (decodeShouldThrow) throw new Error('ffmpeg decode failed (mock).');
    return { durationSec: decodedDurationSec };
  }),
  readWavPcm: vi.fn(async () => currentChunkPcm),
}));

// Writes a minimal WebM-shaped part (pseudo header bytes + a Cluster marker) so
// the worker's readFile/init-segment-prepend step has real bytes to work with;
// the actual decode is mocked above, so only the byte structure matters.
vi.mock('./part-window.js', () => ({
  downloadPartBySeq: vi.fn(async (...args: unknown[]) => {
    const destPath = args[5] as string;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      destPath,
      Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]), // pseudo EBML/header bytes
        Buffer.from([0x1f, 0x43, 0xb6, 0x75]), // Cluster id — init-segment boundary
        Buffer.from([0x81, 0x00, 0x00]), // pseudo cluster body
      ]),
    );
  }),
}));

const appendLiveTurns = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../media/live-turns-store.js', () => ({ appendLiveTurns: (...args: unknown[]) => appendLiveTurns(...args) }));

const upsertAll = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./live-speaker-repository.js', async () => {
  const { sessionRegistries } = await import('../speaker/session-speaker-registry.js');
  return {
    ensureRegistry: vi.fn(async (_db: unknown, meetingId: string) => sessionRegistries.get(meetingId)),
    upsertAll: (...args: unknown[]) => upsertAll(...args),
  };
});

vi.mock('../speaker/resolve-speakers.js', () => ({ readMatchThreshold: vi.fn(async () => 0.5) }));

/** Profiles the (unmocked, real) `matchSpeaker`/`acceptMatch` pass sees on the next `cachedProfiles` call — empty by default, set per-test. */
let profilesForMatch: import('../speaker/profile-store.js').SpeakerProfile[] = [];
const cachedProfilesMock = vi.fn(async () => profilesForMatch);
const invalidateProfileCacheMock = vi.fn(() => undefined);
vi.mock('../speaker/profile-store.js', () => ({
  listProfiles: vi.fn(async () => profilesForMatch),
  cachedProfiles: (...args: unknown[]) => cachedProfilesMock(...(args as [])),
  invalidateProfileCache: () => invalidateProfileCacheMock(),
  resetProfileCacheForTests: () => invalidateProfileCacheMock(),
}));

let embeddingCallCount = 0;
/** The first sample value of every PCM slice actually embedded, in call order — used with `indexTaggedChunk` to prove WHERE a slice was cut from. */
const embeddingInputFirstSamples: number[] = [];
vi.mock('../speaker/embedding-extractor.js', () => ({
  computeEmbedding: vi.fn(async (pcm: Float32Array) => {
    embeddingCallCount += 1;
    embeddingInputFirstSamples.push(pcm[0]);
    return new Float32Array([1, 0, 0, 0]);
  }),
}));

const { processChunk } = await import('./chunk-worker.js');
const { sessionRegistries } = await import('../speaker/session-speaker-registry.js');

function toneChunk(durationSec: number, amplitude = 0.5) {
  const samples = new Float32Array(durationSec * SAMPLE_RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin(i / 4);
  return samples;
}

/**
 * A chunk where `pcm[i] === i` — not realistic audio, but `computeEmbedding`
 * is mocked (never inspects real audio content) and `hasRealEnergy`'s RMS
 * gate passes trivially on values this large. Lets a test assert EXACTLY
 * which sample a slice started at (`embeddingInputFirstSamples`), proving a
 * turn was cut from the right position rather than merely "some" position.
 */
function indexTaggedChunk(durationSec: number) {
  const samples = new Float32Array(durationSec * SAMPLE_RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = i;
  return samples;
}

const fakeDb = {} as AppDbBotClient;
const fakeHub = {} as RoomBoundHubClient;

function ctx() {
  return { db: fakeDb, hub: fakeHub, folderId: 'folder-1' };
}

describe('chunk-worker processChunk', () => {
  beforeEach(() => {
    embeddingCallCount = 0;
    embeddingInputFirstSamples.length = 0;
    decodeShouldThrow = false;
    decodedDurationSec = 60;
    appendLiveTurns.mockClear();
    upsertAll.mockClear();
    cachedProfilesMock.mockClear();
    invalidateProfileCacheMock.mockClear();
    profilesForMatch = [];
    env.speakerMinSegmentSec = 2;
    env.liveChunkOverlapSec = 8;
  });

  it('embeds a well-formed turn, folds it into the registry, appends live turns, and upserts once', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = toneChunk(60);

    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 0, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 0, endMs: 20_000, final: true }] },
      new AbortController().signal,
    );

    const registry = sessionRegistries.get(meetingId);
    const snapshot = registry.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].liveSpeechSec).toBeCloseTo(20);
    expect(embeddingCallCount).toBe(1);
    expect(appendLiveTurns).toHaveBeenCalledTimes(1);
    expect(upsertAll).toHaveBeenCalledTimes(1);
    expect(registry.decodedSecBefore(1)).toBe(60); // noteDecoded advanced the clock
  });

  it('rejects a span pointing into silence without embedding it', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = new Float32Array(60 * SAMPLE_RATE); // all zeros -> silent

    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 0, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 0, endMs: 20_000, final: true }] },
      new AbortController().signal,
    );

    expect(embeddingCallCount).toBe(0);
    expect(sessionRegistries.get(meetingId).snapshot()).toHaveLength(0);
  });

  it('defers a turn crossing the chunk boundary ([58s,63s] fixture) and embeds it exactly once on the next chunk', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = toneChunk(60);

    // Chunk 0: the turn's endMs (63s) exceeds this chunk's own audio (60s) -> deferred, not embedded.
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 0, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 58_000, endMs: 63_000, final: false }] },
      new AbortController().signal,
    );
    expect(embeddingCallCount).toBe(0);

    // Chunk 1: the client resends the SAME turn now final:true, PLUS the registry replays it from `deferred`.
    currentChunkPcm = toneChunk(60);
    await processChunk(
      ctx(),
      {
        roomId: 'room-1',
        meetingId,
        seq: 1,
        durationMs: 60_000,
        segments: [{ speaker: 's0:1', startMs: 58_000, endMs: 63_000, final: true }],
      },
      new AbortController().signal,
    );

    expect(embeddingCallCount).toBe(1); // embedded exactly once, not twice
    const snapshot = sessionRegistries.get(meetingId).snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].liveSpeechSec).toBeCloseTo(5); // 63s - 58s, counted once
  });

  it('a chunk that fails to decode does not throw, and the clock still advances for the chunk after it', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = toneChunk(60);

    // Chunks 0-4 succeed normally.
    for (let seq = 0; seq < 5; seq++) {
      await processChunk(ctx(), { roomId: 'room-1', meetingId, seq, durationMs: 60_000, segments: [] }, new AbortController().signal);
    }
    const registry = sessionRegistries.get(meetingId);
    expect(registry.decodedSecBefore(5)).toBe(300);
    expect(registry.isDegraded()).toBe(false);

    // Chunk 5 fails at decode.
    decodeShouldThrow = true;
    await expect(
      processChunk(ctx(), { roomId: 'room-1', meetingId, seq: 5, durationMs: 60_000, segments: [] }, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(registry.isDegraded()).toBe(true);
    expect(registry.decodedSecBefore(6)).toBe(360); // clock advanced by durationMs despite the failure

    // Chunk 6 succeeds again, on top of the advanced clock.
    decodeShouldThrow = false;
    currentChunkPcm = toneChunk(60);
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 6, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 360_500, endMs: 380_000, final: true }] },
      new AbortController().signal,
    );
    expect(sessionRegistries.get(meetingId).snapshot()).toHaveLength(1);
  });
});

describe('chunk-worker processChunk — client-stamped partStartMs', () => {
  beforeEach(() => {
    embeddingCallCount = 0;
    embeddingInputFirstSamples.length = 0;
    decodeShouldThrow = false;
    decodedDurationSec = 60;
    appendLiveTurns.mockClear();
    upsertAll.mockClear();
    cachedProfilesMock.mockClear();
    invalidateProfileCacheMock.mockClear();
    profilesForMatch = [];
    env.speakerMinSegmentSec = 2;
    env.liveChunkOverlapSec = 8;
  });

  it('(a) a processing delay before part 2 does not shift where its turn is sliced from', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = indexTaggedChunk(60);
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 0, durationMs: 60_000, partStartMs: 0, segments: [] },
      new AbortController().signal,
    );

    // Stand-in for a real upload retry delaying part 2's arrival — chunk-worker
    // never reads wall-clock time itself, only the client's own stamps, so a
    // real delay here (of any length) must not move where the turn is cut from.
    await new Promise((resolve) => setTimeout(resolve, 20));

    currentChunkPcm = indexTaggedChunk(60);
    const seg = { speaker: 's0:1', startMs: 65_000, endMs: 69_000, final: true };
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 1, durationMs: 60_000, partStartMs: 60_000, segments: [seg] },
      new AbortController().signal,
    );

    expect(embeddingCallCount).toBe(1);
    expect(embeddingInputFirstSamples[0]).toBe((seg.startMs - 60_000) * 16); // 5s into part 1's OWN audio
  });

  it('(b) a client-side seq gap clears the ring and raises degraded, but the next part still aligns from its own stamp', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = indexTaggedChunk(60);
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 0, durationMs: 60_000, partStartMs: 0, segments: [] },
      new AbortController().signal,
    );

    // seq 1 never arrives (the upload queue's own cap dropped it client-side) — seq 2 is next.
    currentChunkPcm = indexTaggedChunk(60);
    const seg = { speaker: 's0:1', startMs: 125_000, endMs: 129_000, final: true };
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 2, durationMs: 60_000, partStartMs: 120_000, segments: [seg] },
      new AbortController().signal,
    );

    const registry = sessionRegistries.get(meetingId);
    expect(registry.isDegraded()).toBe(true);
    expect(embeddingCallCount).toBe(1);
    expect(embeddingInputFirstSamples[0]).toBe((seg.startMs - 120_000) * 16); // aligned from its OWN stamp, unaffected by the gap
  });

  it('(c) a rebuilt (fresh) registry aligns the next part from its own absolute stamp, with no prior state', async () => {
    const meetingId = `m-${Math.random()}`; // never touched before — stands in for a registry rebuilt after a restart mid-meeting
    currentChunkPcm = indexTaggedChunk(60);
    const seg = { speaker: 's0:1', startMs: 2_525_000, endMs: 2_529_000, final: true };
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 42, durationMs: 60_000, partStartMs: 2_520_000, segments: [seg] },
      new AbortController().signal,
    );

    expect(embeddingCallCount).toBe(1);
    expect(embeddingInputFirstSamples[0]).toBe((seg.startMs - 2_520_000) * 16);
  });

  it('(d) a bogus (negative) partStartMs is rejected — the chunk is skipped and the meeting is flagged degraded', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = indexTaggedChunk(60);
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 0, durationMs: 60_000, partStartMs: -5, segments: [{ speaker: 's0:1', startMs: 0, endMs: 4_000, final: true }] },
      new AbortController().signal,
    );

    expect(embeddingCallCount).toBe(0);
    expect(sessionRegistries.get(meetingId).isDegraded()).toBe(true);
  });

  it('(d) a durationMs beyond the maximum allowed part length is rejected', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = indexTaggedChunk(60);
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 0, durationMs: 300_000, partStartMs: 0, segments: [] },
      new AbortController().signal,
    );

    expect(sessionRegistries.get(meetingId).isDegraded()).toBe(true);
  });

  it('(d) a partStartMs breaking continuity with the previous part is rejected without embedding', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = indexTaggedChunk(60);
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 0, durationMs: 60_000, partStartMs: 0, segments: [] },
      new AbortController().signal,
    );

    currentChunkPcm = indexTaggedChunk(60);
    await processChunk(
      ctx(),
      {
        roomId: 'room-1',
        meetingId,
        seq: 1,
        durationMs: 60_000,
        partStartMs: 999_000, // wildly inconsistent with part 0's own declared span (no gap to excuse it — seq is contiguous)
        segments: [{ speaker: 's0:1', startMs: 999_500, endMs: 1_003_000, final: true }],
      },
      new AbortController().signal,
    );

    expect(embeddingCallCount).toBe(0);
    expect(sessionRegistries.get(meetingId).isDegraded()).toBe(true);
  });

  it('(e) an older client that never sends partStartMs keeps using the cumulative fallback clock, unaffected', async () => {
    const meetingId = `m-${Math.random()}`;
    currentChunkPcm = toneChunk(60);
    await processChunk(
      ctx(),
      { roomId: 'room-1', meetingId, seq: 0, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 0, endMs: 20_000, final: true }] },
      new AbortController().signal,
    );

    const registry = sessionRegistries.get(meetingId);
    expect(embeddingCallCount).toBe(1);
    expect(registry.decodedSecBefore(1)).toBe(60); // still governed by noteDecoded, exactly as before this stamp existed
    expect(registry.lastPartStampForValidation()).toBeNull(); // the new tracking is never touched for an old client
  });
});

describe('chunk-worker processChunk — profile-match retry backoff (no cap, gated by NEW quality speech)', () => {
  beforeEach(() => {
    embeddingCallCount = 0;
    embeddingInputFirstSamples.length = 0;
    decodeShouldThrow = false;
    decodedDurationSec = 60;
    appendLiveTurns.mockClear();
    upsertAll.mockClear();
    cachedProfilesMock.mockClear();
    invalidateProfileCacheMock.mockClear();
    profilesForMatch = [];
    env.speakerMinSegmentSec = 2;
    env.liveChunkOverlapSec = 8;
    env.liveMinSpeechSec = 8;
    env.speakerMatchThreshold = 0.5;
    env.speakerMatchMargin = 0;
  });

  it('waits for >=15s of quality speech before the FIRST attempt, then backs off until another 15s before retrying — with no cap on attempts', async () => {
    const meetingId = `m-${Math.random()}`;
    // `computeEmbedding` is mocked to always return the SAME vector, so every
    // turn that reaches the registry at all (>= SPEAKER_MIN_SEGMENT_SEC, the
    // chunk-level floor) always clears ASSIGN/UPDATE too — every embedded
    // second counts as quality speech here, no `rejected-*` turns to account for.

    // Part 0 [0,60000): turn 1, 9s — enough speech but only 1 turn, not sticky yet.
    currentChunkPcm = toneChunk(60);
    await processChunk(ctx(), { roomId: 'room-1', meetingId, seq: 0, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 0, endMs: 9_000, final: true }] }, new AbortController().signal);
    expect(cachedProfilesMock).not.toHaveBeenCalled();

    // Part 1 [60000,120000): turn 2, +2s -> sticky (11s, 2 turns) but only 11s quality speech, still < 15s.
    currentChunkPcm = toneChunk(60);
    await processChunk(ctx(), { roomId: 'room-1', meetingId, seq: 1, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 60_000, endMs: 62_000, final: true }] }, new AbortController().signal);
    expect(cachedProfilesMock).not.toHaveBeenCalled();

    // Part 2 [120000,180000): turn 3, +4s -> 15s quality speech total — first attempt fires this chunk.
    currentChunkPcm = toneChunk(60);
    await processChunk(ctx(), { roomId: 'room-1', meetingId, seq: 2, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 120_000, endMs: 124_000, final: true }] }, new AbortController().signal);
    expect(cachedProfilesMock).toHaveBeenCalledTimes(1);

    // Part 3 [180000,240000): turn 4, +2s only -> backed off right after the last attempt (2s < 15s), no new call.
    currentChunkPcm = toneChunk(60);
    await processChunk(ctx(), { roomId: 'room-1', meetingId, seq: 3, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 180_000, endMs: 182_000, final: true }] }, new AbortController().signal);
    expect(cachedProfilesMock).toHaveBeenCalledTimes(1);

    // Part 4 [240000,300000): turn 5, +15s more quality speech since the last attempt -> retries, no cap on the number of attempts.
    currentChunkPcm = toneChunk(60);
    await processChunk(ctx(), { roomId: 'room-1', meetingId, seq: 4, durationMs: 60_000, segments: [{ speaker: 's0:1', startMs: 240_000, endMs: 255_000, final: true }] }, new AbortController().signal);
    expect(cachedProfilesMock).toHaveBeenCalledTimes(2);
  });
});
