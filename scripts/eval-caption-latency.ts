/**
 * How fast live captions appear, measured on the server with the real models:
 * a WAV is pushed into a `LiveAsrSession` in 0.5 s chunks at real-time pace (as
 * the iframe does), with the real speaker attribution, and the session is
 * watched every 20 ms.
 *
 *   npx tsx scripts/eval-caption-latency.ts <file.wav>
 *
 * Printed per utterance and as medians:
 *  - draft: when the first draft of an utterance could be shown, after its speech started;
 *  - final: when its final caption could be shown, after the speaker stopped;
 *  - recognise / attribute: the time each step took.
 * The Hub relay round trip (~1 s each way to the iframe) comes on top and is not measured here.
 */
import sherpa from 'sherpa-onnx-node';

import { createVad, recognizeDraft, recognizeUtterance } from '../src/server/asr/asr-engine.js';
import { LiveAsrSession, type LiveAsrEngine } from '../src/server/asr/live-asr-session.js';
import { createLocalSpeakerAttributor } from '../src/server/live-speakers/local-attribution.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: eval-caption-latency.ts <file.wav>');
  process.exit(2);
}
const { samples, sampleRate } = sherpa.readWave(file);
if (sampleRate !== 16000) throw new Error(`expected 16 kHz, got ${sampleRate}`);

const timings = { recognise: [] as number[], draft: [] as number[], attribute: [] as number[] };
const timed = <A extends unknown[], R>(bucket: number[], fn: (...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    const t = performance.now();
    try {
      return await fn(...args);
    } finally {
      bucket.push(performance.now() - t);
    }
  };
const engine: LiveAsrEngine = { createVad, recognize: timed(timings.recognise, recognizeUtterance), recognizeDraft: timed(timings.draft, recognizeDraft) };

const fakeDb = new Proxy({}, { get: (_t, prop) => (prop === 'boundRoomId' ? 'eval-room' : async () => ({ records: [], total: 0 })) });
const fakeHub = new Proxy({}, { get: () => async () => { throw new Error('no Hub in the eval'); } });
const session = new LiveAsrSession('eval-meeting', engine);
const attribute = createLocalSpeakerAttributor({ db: fakeDb as never, hub: fakeHub as never, roomId: 'eval-room', folderId: 'f', meetingId: 'eval-meeting' });
session.attributeSpeaker = Object.assign(timed(timings.attribute, attribute), { flush: attribute.flush });

// Warm the models first: the first decode loads them, which a meeting pays once, not per caption.
await recognizeUtterance(samples.subarray(0, 16000), 0);

const CHUNK = Math.round(Number(process.env.CHUNK_SEC ?? 0.5) * 16000);
const t0 = performance.now();
const now = () => (performance.now() - t0) / 1000;
const firstDraftAt = new Map<number, number>(); // utterance start (rounded atSec) -> wall second
const finals: Array<{ atSec: number; endSec: number; shownAt: number; text: string }> = [];
let cursor = 0;
let lastDraftId = '';
const watcher = setInterval(() => {
  const { captions, cursor: next, draft } = session.captionsSince(cursor);
  for (const c of captions) finals.push({ atSec: c.atSec, endSec: c.endSec, shownAt: now(), text: c.text });
  cursor = next;
  if (draft) {
    const key = Math.round(draft.atSec * 10);
    if (!firstDraftAt.has(key)) firstDraftAt.set(key, now());
    lastDraftId = draft.text;
  }
}, 20);

for (let seq = 0, at = 0; at < samples.length; seq++, at += CHUNK) {
  // Real time: chunk N is sent once its last sample has been "spoken".
  const due = (at + CHUNK) / 16000;
  const wait = due - now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
  await session.push(seq, at / 16000, samples.subarray(at, at + CHUNK));
}
await session.finish();
await new Promise((r) => setTimeout(r, 300));
clearInterval(watcher);
void lastDraftId;

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] : NaN);
const finalLag = finals.map((f) => f.shownAt - f.endSec);
const draftLag = finals
  .map((f) => {
    const key = [...firstDraftAt.keys()].find((k) => Math.abs(k / 10 - f.atSec) < 0.6);
    return key === undefined ? undefined : firstDraftAt.get(key)! - f.atSec;
  })
  .filter((x): x is number => x !== undefined);
for (const f of finals) console.log(`[${f.atSec.toFixed(1)}–${f.endSec.toFixed(1)}] final +${(f.shownAt - f.endSec).toFixed(2)} s  ${f.text.slice(0, 50)}`);
console.log(`\nutterances ${finals.length}, with a draft ${draftLag.length}`);
console.log(`first draft after speech start: median ${median(draftLag).toFixed(2)} s, p90 ${p90(draftLag).toFixed(2)} s`);
console.log(`final after speaker stopped:    median ${median(finalLag).toFixed(2)} s, p90 ${p90(finalLag).toFixed(2)} s`);
console.log(`recognise ${median(timings.recognise).toFixed(0)} ms, draft decode ${median(timings.draft).toFixed(0)} ms (${timings.draft.length} drafts), attribute ${median(timings.attribute).toFixed(0)} ms (median)`);
process.exit(0);
