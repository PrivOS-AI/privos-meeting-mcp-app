import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));
// No models in tests: a VAD that closes a segment on every silent window, a recognizer that echoes.
vi.mock('../asr/asr-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../asr/asr-engine.js')>();
  return {
    ...actual,
    createVad: async () => {
      let fed = 0;
      let start: number | null = null;
      let buf: number[] = [];
      const ready: Array<{ start: number; samples: Float32Array }> = [];
      const close = () => {
        if (start !== null) ready.push({ start, samples: Float32Array.from(buf) });
        start = null;
        buf = [];
      };
      return {
        acceptWaveform(w: Float32Array) {
          if (w[0] !== 0) {
            start ??= fed;
            buf.push(...w);
          } else close();
          fed += w.length;
        },
        isEmpty: () => ready.length === 0,
        front: () => ready[0],
        pop: () => void ready.shift(),
        flush: close,
        reset: () => undefined,
      };
    },
    recognizeUtterance: async () => ({ lang: 'vi', text: 'Xin chào', words: [], confidence: 1 }),
  };
});

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { audioPushTool } = await import('./audio-push-tool.js');
const { resetLiveSessionsForTests, liveSessionFor } = await import('../asr/live-asr-session.js');
const { resetRateLimits } = await import('./rate-limiter.js');
const { env } = await import('../env.js');

function ctx(userId = 'owner-1'): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' } };
}

/** PCM16 base64 of `speechWindows` loud 512-sample windows followed by one silent window. */
function pcm(speechWindows: number): string {
  const samples = (speechWindows + 1) * 512;
  const bytes = Buffer.alloc(samples * 2);
  for (let i = 0; i < speechWindows * 512; i++) bytes.writeInt16LE(16000, i * 2);
  return bytes.toString('base64');
}

const args = (over: Record<string, unknown> = {}) => ({ roomId: 'room-1', meetingId: 'meeting-1', seq: 0, chunkStartSec: 0, sampleRate: 16000, pcm: pcm(4), cursor: 0, ...over });

describe('meeting_audio_push', () => {
  beforeEach(() => {
    resetLiveSessionsForTests();
    resetRateLimits();
    store = { meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'owner-1', status: 'recording' }] };
    fakeHub = installFakeHub({ store });
  });

  it('feeds the audio and returns the captions recognised since the cursor', async () => {
    await audioPushTool.execute(args(), ctx(), {} as never);
    await liveSessionFor('meeting-1', 8)!.finish();
    const second = (await audioPushTool.execute(args({ seq: 1, chunkStartSec: 0.16, pcm: pcm(0), cursor: 0 }), ctx(), {} as never)) as {
      captions: Array<{ text: string }>;
      cursor: number;
    };
    expect(second.captions.map((c) => c.text)).toEqual(['Xin chào']);
    expect(second.cursor).toBe(1);
  });

  it('refuses anyone but the meeting owner', async () => {
    await expect(audioPushTool.execute(args(), ctx('someone-else'), {} as never)).rejects.toMatchObject({ code: 'NOT_MEETING_OWNER' });
  });

  it('refuses a meeting that is not recording', async () => {
    store.meetings[0].status = 'summarized';
    await expect(audioPushTool.execute(args(), ctx(), {} as never)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses more than ~4 s of audio in one push and a non-16 kHz rate', async () => {
    await expect(audioPushTool.execute(args({ pcm: Buffer.alloc(140_000).toString('base64') }), ctx(), {} as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(audioPushTool.execute(args({ sampleRate: 48000 }), ctx(), {} as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a new meeting past the live caption cap', async () => {
    const cap = env.liveMaxConcurrentRecordings;
    env.liveMaxConcurrentRecordings = 1;
    try {
      liveSessionFor('other-meeting', 1);
      await expect(audioPushTool.execute(args(), ctx(), {} as never)).rejects.toMatchObject({ code: 'CAPACITY_REACHED' });
    } finally {
      env.liveMaxConcurrentRecordings = cap;
    }
  });
});
