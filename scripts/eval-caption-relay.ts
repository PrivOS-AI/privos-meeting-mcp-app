/**
 * How late live captions show on screen, relay included: the real models and
 * `LiveAsrSession`, a WAV "spoken" in real time, and every request/answer
 * between the iframe and the server delayed by `ONE_WAY_MS` (default 500 ms,
 * about the PrivOS relay's ~1 s round trip). Two client designs:
 *
 *  - `MODE=serial`: one push every 0.5 s, one at a time, captions riding the
 *    push answer after a 0.7 s settle (the app up to 1.3.1);
 *  - `MODE=pipelined`: a push every 0.25 s, up to 3 in flight, and one
 *    `meeting_captions_wait` held open (the current design).
 *
 *   MODE=pipelined npx tsx scripts/eval-caption-relay.ts <file.wav>
 */
import sherpa from 'sherpa-onnx-node';

import { recognizeUtterance } from '../src/server/asr/asr-engine.js';
import { LiveAsrSession } from '../src/server/asr/live-asr-session.js';
import { createLocalSpeakerAttributor } from '../src/server/live-speakers/local-attribution.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: eval-caption-relay.ts <file.wav>');
  process.exit(2);
}
const MODE = process.env.MODE === 'serial' ? 'serial' : 'pipelined';
const ONE_WAY_MS = Number(process.env.ONE_WAY_MS ?? 500);
const { samples } = sherpa.readWave(file);
const RATE = 16000;

const fakeDb = new Proxy({}, { get: (_t, prop) => (prop === 'boundRoomId' ? 'eval-room' : async () => ({ records: [], total: 0 })) });
const fakeHub = new Proxy({}, { get: () => async () => { throw new Error('no Hub in the eval'); } });
const session = new LiveAsrSession('eval-meeting');
session.attributeSpeaker = createLocalSpeakerAttributor({ db: fakeDb as never, hub: fakeHub as never, roomId: 'eval-room', folderId: 'f', meetingId: 'eval-meeting' });
await recognizeUtterance(samples.subarray(0, RATE), 0); // warm the models

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const now = () => (performance.now() - t0) / 1000;
/** Audio "spoken" so far, in samples. */
const captured = () => Math.min(samples.length, Math.floor(now() * RATE));

const finals = new Map<string, { atSec: number; endSec: number; shownAt: number }>();
const firstDraft = new Map<number, number>();
/** What reached the screen: called when an answer arrives in the iframe. */
const show = (answer: ReturnType<LiveAsrSession['captionsSince']>) => {
  for (const c of answer.captions) if (!finals.has(c.id)) finals.set(c.id, { atSec: c.atSec, endSec: c.endSec, shownAt: now() });
  if (answer.draft) {
    const key = Math.round(answer.draft.atSec * 10);
    if (!firstDraft.has(key)) firstDraft.set(key, now());
  }
};

let sent = 0; // samples cut into pushes
let seq = 0;
const total = samples.length;
const done = () => sent >= total;

if (MODE === 'serial') {
  let cursor = 0;
  while (!done() || captured() < total) {
    await sleep(500);
    const upTo = captured();
    if (upTo <= sent) continue;
    const chunk = samples.subarray(sent, Math.min(upTo, sent + RATE * 4));
    const startSec = sent / RATE;
    sent += chunk.length;
    const mySeq = seq++;
    await sleep(ONE_WAY_MS); // request travels
    await session.push(mySeq, startSec, chunk);
    await session.settle(700);
    const answer = session.captionsSince(cursor);
    cursor = answer.cursor;
    await sleep(ONE_WAY_MS); // answer travels
    show(answer);
  }
} else {
  let inFlight = 0;
  let cursor = 0;
  let draftRev = 0;
  let closed = false;
  // WAITERS (default 2) waits held open, the second half a round trip behind the first, so one
  // is always on the server when a caption is decoded.
  const waiters = Number(process.env.WAITERS ?? 2);
  for (let w = 0; w < waiters; w++) {
    void (async () => {
      if (w > 0) await sleep(ONE_WAY_MS);
      while (!closed) {
        await sleep(ONE_WAY_MS);
        await session.waitForUpdate(cursor, draftRev, 5000);
        const answer = session.captionsSince(cursor);
        await sleep(ONE_WAY_MS);
        if (answer.cursor >= cursor) {
          cursor = answer.cursor;
          draftRev = answer.draftRev;
        }
        show(answer);
        if (w > 0) await sleep(ONE_WAY_MS); // stay half a round trip behind
      }
    })();
  }
  while (!done()) {
    await sleep(250);
    const upTo = captured();
    while (inFlight < 3 && upTo - sent >= RATE * 0.2) {
      const chunk = samples.subarray(sent, Math.min(upTo, sent + RATE * 4));
      const startSec = sent / RATE;
      sent += chunk.length;
      const mySeq = seq++;
      inFlight++;
      void (async () => {
        await sleep(ONE_WAY_MS);
        await session.push(mySeq, startSec, chunk);
        await sleep(ONE_WAY_MS);
        inFlight--;
      })();
    }
    if (captured() >= total && total - sent < RATE * 0.2 && sent < total) {
      const startSec = sent / RATE;
      const chunk = samples.subarray(sent);
      sent = total;
      await sleep(ONE_WAY_MS);
      await session.push(seq++, startSec, chunk);
    }
  }
  await sleep(4000);
  closed = true;
}
await session.finish();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const shown = [...finals.values()];
const finalLag = shown.map((f) => f.shownAt - f.endSec);
const draftLag = shown
  .map((f) => [...firstDraft.entries()].find(([k]) => Math.abs(k / 10 - f.atSec) < 0.6)?.[1])
  .map((at, i) => (at === undefined ? undefined : at - shown[i].atSec))
  .filter((x): x is number => x !== undefined);
console.log(`${MODE}, ${ONE_WAY_MS} ms each way: ${shown.length} captions`);
console.log(`  first draft on screen after speech start: median ${median(draftLag).toFixed(2)} s (max ${Math.max(...draftLag).toFixed(2)})`);
console.log(`  final on screen after speaker stopped:    median ${median(finalLag).toFixed(2)} s (max ${Math.max(...finalLag).toFixed(2)})`);
process.exit(0);
