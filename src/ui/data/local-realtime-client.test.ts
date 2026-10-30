import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AudioPushRequest, AudioPushResponse, CaptionsWaitRequest } from './local-realtime-client.js';
import { createLocalConnection } from './local-realtime-client.js';
import type { CaptionEvent, RealtimeConnectionOptions } from './realtime-client.js';

/** A 16 kHz AudioContext whose processor the test drives by hand. */
function installFakeAudio() {
  const processors: Array<{ onaudioprocess: ((event: unknown) => void) | null }> = [];
  class FakeAudioContext {
    sampleRate = 16_000;
    destination = {};
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      const processor = { onaudioprocess: null as ((event: unknown) => void) | null, connect() {}, disconnect() {} };
      processors.push(processor);
      return processor;
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  /** Feeds `seconds` of audio through the processor, as the browser would. */
  return (seconds: number) => {
    const samples = new Float32Array(Math.round(seconds * 16_000)).fill(0.1);
    processors[0].onaudioprocess?.({ inputBuffer: { getChannelData: () => samples, duration: seconds } });
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(extra: Partial<Record<'pushAudio' | 'waitCaptions', unknown>>) {
  const captions: CaptionEvent[] = [];
  const statuses: string[] = [];
  const connection = createLocalConnection({
    stream: {} as MediaStream,
    recorderEpochMs: performance.now(),
    translate: false,
    mintToken: async () => ({}) as never,
    onCaption: (event: CaptionEvent) => captions.push(event),
    onTurns: () => undefined,
    onStarted: () => undefined,
    onStatus: (status: string) => statuses.push(status),
    ...extra,
  } as unknown as RealtimeConnectionOptions);
  return { connection, captions, statuses };
}

describe('local captions client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps several pushes in flight, in seq order, and they only feed audio', async () => {
    const feed = installFakeAudio();
    const pushes: AudioPushRequest[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const pushAudio = async (request: AudioPushRequest): Promise<AudioPushResponse> => {
      pushes.push(request);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(900); // a slow relay round trip
      inFlight--;
      return { captions: [], cursor: 0 };
    };
    const { connection } = connect({ pushAudio, waitCaptions: async () => (await sleep(50), { captions: [], cursor: 0, draft: null, draftRev: 0 }) });
    for (let i = 0; i < 8; i++) {
      feed(0.25);
      await sleep(260);
    }
    expect(maxInFlight).toBe(3);
    expect(pushes.map((p) => p.seq)).toEqual(pushes.map((_, i) => i));
    expect(pushes.every((p) => p.captions === false)).toBe(true);
    // Each chunk starts where the previous ended: no gap, no overlap on the meeting clock.
    for (let i = 1; i < pushes.length; i++) expect(pushes[i].chunkStartSec).toBeCloseTo(pushes[i - 1].chunkStartSec + 0.25, 3);
    await connection.stop();
  });

  it('shows a caption the moment the held wait answers, then asks again from the new cursor', async () => {
    installFakeAudio();
    const waits: CaptionsWaitRequest[] = [];
    let answer: ((response: AudioPushResponse) => void) | null = null;
    const waitCaptions = (request: CaptionsWaitRequest) => {
      waits.push(request);
      return new Promise<AudioPushResponse>((resolve) => {
        answer = resolve;
      });
    };
    const { connection, captions } = connect({ pushAudio: async () => ({ captions: [], cursor: 0 }), waitCaptions });
    await sleep(10);
    expect(waits).toEqual([{ cursor: 0, draftRev: 0, waitMs: 5000 }]);
    answer!({ captions: [{ index: 0, id: 'm:local:0', text: 'Xin chào', atSec: 1, endSec: 2, lang: 'vi' }], cursor: 1, draft: null, draftRev: 3 });
    await sleep(10);
    expect(captions).toMatchObject([{ kind: 'final', text: 'Xin chào' }]);
    expect(waits[1]).toEqual({ cursor: 1, draftRev: 3, waitMs: 5000 });
    answer!({ captions: [], cursor: 1, draft: null, draftRev: 3 });
    await connection.stop();
  });

  it('sends a failed chunk again with the same seq, after a short pause', async () => {
    const feed = installFakeAudio();
    const seqs: number[] = [];
    let failOnce = true;
    const pushAudio = async (request: AudioPushRequest): Promise<AudioPushResponse> => {
      seqs.push(request.seq);
      if (failOnce) {
        failOnce = false;
        throw new Error('relay hiccup');
      }
      return { captions: [], cursor: 0 };
    };
    const { connection, statuses } = connect({ pushAudio, waitCaptions: async () => (await sleep(50), { captions: [], cursor: 0, draft: null, draftRev: 0 }) });
    feed(0.25);
    await sleep(1_600);
    expect(seqs.slice(0, 2)).toEqual([0, 0]);
    expect(statuses).toContain('reconnecting');
    expect(statuses.at(-1)).toBe('live');
    await connection.stop();
  });
});
