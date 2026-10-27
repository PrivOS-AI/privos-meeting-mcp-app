import { beforeEach, describe, expect, it, vi } from 'vitest';

const RATE = 16000;
const DIM = 192;

/** A "voice": samples whose first value picks a one-hot embedding axis (plus a little noise so voices are not identical). */
function voice(axis: number, seconds: number, jitter = 0): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  samples[0] = axis + jitter;
  return samples;
}

const appended: unknown[][] = [];
let recognitionOn = true;

vi.mock('../speaker/embedding-extractor.js', () => ({
  computeEmbedding: async (samples: Float32Array) => {
    const axis = Math.floor(samples[0]);
    const jitter = samples[0] - axis;
    const v = new Float32Array(DIM);
    v[axis] = 1;
    v[(axis + 1) % DIM] = jitter;
    return v;
  },
}));
vi.mock('../speaker/resolve-speakers.js', () => ({ isSpeakerRecognitionEnabled: async () => recognitionOn }));
vi.mock('../media/live-turns-store.js', () => ({ appendLiveTurns: async (_hub: unknown, _room: unknown, _folder: unknown, spans: unknown[]) => void appended.push(spans) }));
vi.mock('../speaker/speaker-diagnostics-log.js', () => ({ append: () => undefined, flush: async () => undefined }));
vi.mock('./live-speaker-repository.js', async () => {
  const { sessionRegistries } = await import('../speaker/session-speaker-registry.js');
  return { ensureRegistry: async (_db: unknown, meetingId: string) => sessionRegistries.get(meetingId), upsertAll: async () => undefined };
});
vi.mock('./chunk-worker.js', () => ({
  matchPendingAgainstProfiles: async () => undefined,
  toDiagnosticEvent: () => ({}),
  runOnMeetingQueue: async (_meetingId: string, fn: (signal: AbortSignal) => Promise<unknown>) => fn(new AbortController().signal),
}));

const { createLocalSpeakerAttributor } = await import('./local-attribution.js');
const { sessionRegistries } = await import('../speaker/session-speaker-registry.js');

let meetingSeq = 0;
function attributor() {
  meetingSeq += 1;
  return createLocalSpeakerAttributor({ db: {} as never, hub: {} as never, roomId: 'room-1', folderId: 'folder-1', meetingId: `m${meetingSeq}` });
}

describe('local speaker attribution', () => {
  beforeEach(() => {
    appended.length = 0;
    recognitionOn = true;
  });

  it('gives the same voice the same session speaker and a different voice a new one', async () => {
    const attribute = attributor();
    const a1 = await attribute({ index: 0, samples: voice(3, 2.5), atSec: 0, endSec: 2.5 });
    const b1 = await attribute({ index: 1, samples: voice(40, 2.5), atSec: 3, endSec: 5.5 });
    const a2 = await attribute({ index: 2, samples: voice(3, 3, 0.05), atSec: 6, endSec: 9 });
    expect(a1).toBeTruthy();
    expect(b1).toBeTruthy();
    expect(b1).not.toBe(a1);
    expect(a2).toBe(a1);
  });

  it('keeps a too-short utterance with the person who just spoke, and leaves a lone one unattributed', async () => {
    const attribute = attributor();
    const a = await attribute({ index: 0, samples: voice(5, 2), atSec: 0, endSec: 2 });
    expect(await attribute({ index: 1, samples: voice(60, 0.5), atSec: 2.5, endSec: 3 })).toBe(a);
    expect(await attribute({ index: 2, samples: voice(60, 0.5), atSec: 20, endSec: 20.5 })).toBeUndefined();
  });

  it('computes nothing when the room turned speaker recognition off', async () => {
    recognitionOn = false;
    const attribute = attributor();
    expect(await attribute({ index: 0, samples: voice(7, 3), atSec: 0, endSec: 3 })).toBeUndefined();
    expect(sessionRegistries.has(`m${meetingSeq}`)).toBe(false);
  });

  it('writes the attributed turns to live-turns.json on flush, for the post-meeting job', async () => {
    const attribute = attributor();
    const a = await attribute({ index: 0, samples: voice(9, 2), atSec: 1, endSec: 3 });
    await attribute.flush();
    expect(appended).toEqual([[{ id: `${a}:1000`, speakerKey: a, startMs: 1000, endMs: 3000, text: '', sessionIndex: 0 }]]);
  });
});
