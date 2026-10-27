import { beforeEach, describe, expect, it } from 'vitest';

import { closeLiveSession, liveSessionFor, LiveAsrSession, pcm16ToFloat32, resetLiveSessionsForTests, type LiveAsrEngine } from './live-asr-session.js';

const RATE = 16000;
const WINDOW = 512;

/**
 * A stand-in VAD: a window whose first sample is non-zero is speech; the first
 * silent window after speech closes the segment. `start` counts samples since
 * creation or reset, like Silero's.
 */
function fakeEngine(recognized: string[] = []): LiveAsrEngine & { recognizeCalls: Array<{ atSec: number; length: number }> } {
  const recognizeCalls: Array<{ atSec: number; length: number }> = [];
  return {
    recognizeCalls,
    async createVad() {
      let fed = 0;
      let speechStart: number | null = null;
      let speech: Float32Array[] = [];
      const ready: Array<{ start: number; samples: Float32Array }> = [];
      const close = () => {
        if (speechStart === null) return;
        const samples = new Float32Array(speech.reduce((n, s) => n + s.length, 0));
        let at = 0;
        for (const s of speech) {
          samples.set(s, at);
          at += s.length;
        }
        ready.push({ start: speechStart, samples });
        speechStart = null;
        speech = [];
      };
      return {
        acceptWaveform(window: Float32Array) {
          if (window[0] !== 0) {
            speechStart ??= fed;
            speech.push(window.slice());
          } else {
            close();
          }
          fed += window.length;
        },
        isEmpty: () => ready.length === 0,
        front: () => ready[0],
        pop: () => void ready.shift(),
        flush: () => close(),
        reset: () => {
          fed = 0;
          speechStart = null;
          speech = [];
        },
        isDetected: () => speechStart !== null,
      } as unknown as Awaited<ReturnType<LiveAsrEngine['createVad']>>;
    },
    async recognize(samples, atSec) {
      recognizeCalls.push({ atSec, length: samples.length });
      return { text: recognized.shift() ?? `utterance ${recognizeCalls.length}`, lang: 'vi' };
    },
  };
}

const speech = (windows: number) => new Float32Array(windows * WINDOW).fill(0.5);
const silence = (windows: number) => new Float32Array(windows * WINDOW);
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('LiveAsrSession', () => {
  beforeEach(() => resetLiveSessionsForTests());

  it('turns each finished utterance into one final caption on the meeting clock', async () => {
    const engine = fakeEngine(['Xin chào', 'Hello team']);
    const session = new LiveAsrSession('m1', engine);
    // Clock starts at 10 s: 2 silent windows, 4 speech, 2 silent, 3 speech, 2 silent.
    await session.push(0, 10, join(silence(2), speech(4), silence(2), speech(3), silence(2)));
    await session.finish();

    const { captions, cursor } = session.captionsSince(0);
    expect(captions.map((c) => c.text)).toEqual(['Xin chào', 'Hello team']);
    expect(captions[0].atSec).toBeCloseTo(10 + (2 * WINDOW) / RATE, 5);
    expect(captions[1].atSec).toBeCloseTo(10 + (8 * WINDOW) / RATE, 5);
    expect(cursor).toBe(2);
    expect(session.captionsSince(1).captions.map((c) => c.text)).toEqual(['Hello team']);
  });

  it('ignores a retried chunk (same seq) instead of feeding it twice', async () => {
    const engine = fakeEngine();
    const session = new LiveAsrSession('m1', engine);
    const chunk = join(speech(3), silence(1));
    await session.push(0, 0, chunk);
    await session.push(0, 0, chunk);
    await session.finish();
    expect(engine.recognizeCalls).toHaveLength(1);
    expect(session.degraded).toBe(false);
  });

  it('marks a seq gap degraded and re-anchors the clock on the new chunk start', async () => {
    const engine = fakeEngine();
    const session = new LiveAsrSession('m1', engine);
    await session.push(0, 0, join(speech(2), silence(1)));
    await session.push(5, 30, join(speech(2), silence(1)));
    await session.finish();
    expect(session.degraded).toBe(true);
    expect(engine.recognizeCalls.map((c) => Math.round(c.atSec))).toEqual([0, 30]);
  });

  it('carries samples that do not fill a whole VAD window into the next chunk', async () => {
    const engine = fakeEngine();
    const session = new LiveAsrSession('m1', engine);
    const all = join(speech(3), silence(2));
    const cut = WINDOW * 2 + 100;
    await session.push(0, 0, all.subarray(0, cut));
    await session.push(1, cut / RATE, all.subarray(cut));
    await session.finish();
    expect(engine.recognizeCalls).toEqual([{ atSec: 0, length: 3 * WINDOW }]);
  });
});

describe('liveSessionFor', () => {
  beforeEach(() => resetLiveSessionsForTests());

  it('reuses a meeting session and refuses a new one past the cap', () => {
    const engine = fakeEngine();
    const a = liveSessionFor('a', 2, engine);
    expect(liveSessionFor('a', 2, engine)).toBe(a);
    expect(liveSessionFor('b', 2, engine)).not.toBeNull();
    expect(liveSessionFor('c', 2, engine)).toBeNull();
    closeLiveSession('b');
    expect(liveSessionFor('c', 2, engine)).not.toBeNull();
  });
});

describe('pcm16ToFloat32', () => {
  it('decodes little-endian PCM16 into [-1, 1]', () => {
    const bytes = Buffer.alloc(6);
    bytes.writeInt16LE(16384, 0);
    bytes.writeInt16LE(-32768, 2);
    bytes.writeInt16LE(0, 4);
    expect(Array.from(pcm16ToFloat32(bytes))).toEqual([0.5, -1, 0]);
  });
});

describe('LiveAsrSession drafts', () => {
  beforeEach(() => resetLiveSessionsForTests());

  function draftEngine() {
    const engine = fakeEngine(['Chốt thứ Sáu']);
    const draftCalls: number[] = [];
    return Object.assign(engine, {
      draftCalls,
      async recognizeDraft(samples: Float32Array) {
        draftCalls.push(samples.length);
        return `đang nói ${draftCalls.length}`;
      },
    });
  }

  it('shows the speech in progress as a draft, then replaces it with the final', async () => {
    const engine = draftEngine();
    const session = new LiveAsrSession('m1', engine);
    // ~1.3 s of speech, nobody has stopped yet.
    await session.push(0, 0, speech(40));
    await session.settle(100);
    const talking = session.captionsSince(0);
    expect(talking.captions).toEqual([]);
    expect(talking.draft).toMatchObject({ id: 'm1:local:draft', text: 'đang nói 1', atSec: 0 });

    // The speaker stops: the draft goes and the final caption is in the same answer.
    await session.push(1, 40 * WINDOW / RATE, silence(2));
    await session.settle(100);
    const done = session.captionsSince(0);
    expect(done.draft).toBeNull();
    expect(done.captions.map((c) => c.text)).toEqual(['Chốt thứ Sáu']);
  });

  it('decodes a draft at most about once a second', async () => {
    const engine = draftEngine();
    const session = new LiveAsrSession('m1', engine);
    // Six pushes of ~0.32 s of continuous speech (~1.9 s in all).
    for (let seq = 0; seq < 6; seq++) {
      await session.push(seq, (seq * 10 * WINDOW) / RATE, speech(10));
      await session.settle(50);
    }
    expect(engine.draftCalls.length).toBe(1);
  });

  it('emits no draft for a blip shorter than 0.6 s', async () => {
    const engine = draftEngine();
    const session = new LiveAsrSession('m1', engine);
    await session.push(0, 0, speech(10));
    await session.settle(50);
    expect(session.captionsSince(0).draft).toBeNull();
    expect(engine.draftCalls).toEqual([]);
  });
});
