import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the live session received: one entry per push. */
const pushes: Array<{ seq: number; atSec: number; samples: number }> = [];
const uploads: Array<{ fileName: string; bytes: number; duplicateAction: string }> = [];

vi.mock('../asr/live-asr-session.js', () => ({
  liveSessionFor: () => ({
    attributeSpeaker: undefined,
    degraded: false,
    push: async (seq: number, atSec: number, samples: Float32Array) => void pushes.push({ seq, atSec, samples: samples.length }),
    captionsSince: () => ({ captions: [], cursor: 0, draft: null }),
  }),
}));
vi.mock('../live-speakers/local-attribution.js', () => ({ createLocalSpeakerAttributor: () => Object.assign(async () => undefined, { flush: async () => undefined }) }));
vi.mock('../files/hub-file-upload.js', () => ({
  uploadBotFile: async (input: { fileName: string; data: Buffer; duplicateAction: string }) => {
    uploads.push({ fileName: input.fileName, bytes: input.data.length, duplicateAction: input.duplicateAction });
    return { fileId: `f${uploads.length}` };
  },
}));
// The encoder echoes its input: the parts then carry exactly the PCM fed, which is easy to count.
vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.pipe(child.stdout);
    child.stdin.on('finish', () => setTimeout(() => child.emit('close', 0), 5));
    return child;
  },
}));

const { env } = await import('../env.js');
const { browserAudioConfigured, startBrowserAudio, stopBrowserAudio } = await import('./browser-audio-listener.js');
const { meetingId8 } = await import('../../shared/meeting-slug.js');

const SECOND = 32_000; // bytes of 16 kHz PCM16
let meetingCount = 0;
/** A fresh meeting per test: listeners are kept per meeting id. */
function newCtx(now?: () => number) {
  meetingCount += 1;
  return { db: { update: async () => ({}) } as never, hub: {} as never, roomId: 'room-1', folderId: 'folder-1', meetingId: `meeting-abcdef1${meetingCount}`, ...(now ? { now } : {}) };
}

/** A fetch whose /audio-tap answer streams `chunks` (pushed by the test) until `end()`. */
function tapStream(status = 200, body?: unknown) {
  const stream = new PassThrough();
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    calls.push({ url, auth: init.headers.Authorization ?? null });
    if (status !== 200) return new Response(JSON.stringify(body ?? {}), { status });
    // Like fetch: aborting the request ends the body it handed out.
    init.signal.addEventListener('abort', () => stream.destroy(new Error('aborted')), { once: true });
    return new Response(stream as unknown as ReadableStream, { status: 200 });
  });
  return { stream, calls, fetchMock };
}

describe('browser audio listener', () => {
  beforeEach(() => {
    pushes.length = 0;
    uploads.length = 0;
    env.remoteBrowserAudioUrl = 'http://remote-browser:8787/';
    env.remoteBrowserAudioTapKey = 'k'.repeat(40);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is off unless both the URL and the key are set', async () => {
    env.remoteBrowserAudioTapKey = undefined;
    expect(browserAudioConfigured()).toBe(false);
    expect(() => startBrowserAudio(newCtx())).toThrow(expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }));
  });

  it("reads the Room's tap with the operator key and feeds the live session in 0.25 s pushes on the meeting clock", async () => {
    const tap = tapStream();
    vi.stubGlobal('fetch', tap.fetchMock);
    const ctx = newCtx();
    const listener = startBrowserAudio(ctx);
    await vi.waitFor(() => expect(listener.status().state).toBe('listening'));
    expect(tap.calls[0]).toEqual({ url: 'http://remote-browser:8787/audio-tap?roomId=room-1', auth: `Bearer ${'k'.repeat(40)}` });

    tap.stream.write(Buffer.alloc(SECOND)); // 1 s
    await vi.waitFor(() => expect(pushes).toHaveLength(4));
    expect(pushes.map((p) => [p.seq, p.atSec, p.samples])).toEqual([[0, 0, 4000], [1, 0.25, 4000], [2, 0.5, 4000], [3, 0.75, 4000]]);

    tap.stream.write(Buffer.alloc(SECOND / 4)); // a quarter second: stays pending until stop
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await stopBrowserAudio(ctx.meetingId);
    expect(pushes.at(-1)).toMatchObject({ seq: 4, atSec: 1, samples: 4000 });
    expect(status).toMatchObject({ state: 'stopped', heardSec: 1.3, partsUploaded: 1 });
    // One continuous encoded stream, uploaded as a keep_both part named like the iframe's.
    expect(uploads).toEqual([{ fileName: `audio.part-0000-${meetingId8(ctx.meetingId)}.webm`, bytes: SECOND * 1.25, duplicateAction: 'keep_both' }]);
  });

  it('fills a gap in the stream with silence so captions and bookmarks keep wall-clock time', async () => {
    let clock = 0;
    const tap = tapStream();
    vi.stubGlobal('fetch', tap.fetchMock);
    const ctx = newCtx(() => clock);
    const listener = startBrowserAudio(ctx);
    await vi.waitFor(() => expect(listener.status().state).toBe('listening'));
    clock = 10_000; // the first audio arrives 10 s in (nothing played before)
    tap.stream.write(Buffer.alloc(SECOND / 2));
    await vi.waitFor(() => expect(listener.status().heardSec).toBeGreaterThanOrEqual(9.5));
    // The real audio sits right before "now", not at second 0.
    expect(pushes.at(-1)!.atSec).toBeGreaterThanOrEqual(9);
    await stopBrowserAudio(ctx.meetingId);
  });

  it('reports why it cannot hear the browser and keeps the meeting waiting', async () => {
    const tap = tapStream(404, { code: 'no_browser' });
    vi.stubGlobal('fetch', tap.fetchMock);
    const ctx = newCtx();
    const listener = startBrowserAudio(ctx);
    await vi.waitFor(() => expect(listener.status()).toMatchObject({ state: 'waiting', problem: 'no_browser' }));
    const started = Date.now();
    const status = await stopBrowserAudio(ctx.meetingId);
    expect(Date.now() - started).toBeLessThan(1_000); // stop does not sit out the reconnect wait
    expect(status).toMatchObject({ state: 'stopped', partsUploaded: 0 });
    expect(uploads).toEqual([]);
  });

  it('cuts a part every 60 s of audio, in order', async () => {
    const tap = tapStream();
    vi.stubGlobal('fetch', tap.fetchMock);
    // A stream ahead of the wall clock is never padded: the clock stays still here.
    const ctx = newCtx(() => 0);
    const listener = startBrowserAudio(ctx);
    await vi.waitFor(() => expect(listener.status().state).toBe('listening'));
    for (let i = 0; i < 61; i++) tap.stream.write(Buffer.alloc(SECOND));
    await vi.waitFor(() => expect(uploads.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopBrowserAudio(ctx.meetingId);
    const id8 = meetingId8(ctx.meetingId);
    expect(uploads.map((u) => u.fileName)).toEqual([`audio.part-0000-${id8}.webm`, `audio.part-0001-${id8}.webm`]);
    expect(uploads.reduce((sum, u) => sum + u.bytes, 0)).toBe(61 * SECOND);
  });
});
