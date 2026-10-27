/**
 * Live captions + live speakers for the built-in recognizer, end to end on a
 * real WAV: pushes the file into a `LiveAsrSession` in 0.5 s chunks (as the
 * iframe does), with the real recognizer and the real speaker attribution
 * (embedding model + session registry). The Hub is faked (no rows, no Files),
 * so this measures recognition and speaker separation only.
 *
 *   npx tsx scripts/smoke-live-speakers.ts <file.wav>
 * In the image: docker run --rm -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/x.wav:/tmp/x.wav:ro" --entrypoint node_modules/.bin/tsx <image> scripts/smoke-live-speakers.ts /tmp/x.wav
 */
import sherpa from 'sherpa-onnx-node';

import { LiveAsrSession } from '../src/server/asr/live-asr-session.js';
import { createLocalSpeakerAttributor } from '../src/server/live-speakers/local-attribution.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: smoke-live-speakers.ts <file.wav>');
  process.exit(2);
}

/** Any App DB call answers "nothing stored": a fresh meeting in a room with default settings. */
const fakeDb = new Proxy({}, { get: (_target, prop) => (prop === 'boundRoomId' ? 'smoke-room' : async () => ({ records: [], total: 0 })) });
const fakeHub = new Proxy({}, { get: () => async () => { throw new Error('no Hub in the smoke test'); } });

const { samples, sampleRate } = sherpa.readWave(file);
if (sampleRate !== 16000) throw new Error(`expected 16 kHz, got ${sampleRate}`);

const session = new LiveAsrSession('smoke-meeting');
session.attributeSpeaker = createLocalSpeakerAttributor({ db: fakeDb as never, hub: fakeHub as never, roomId: 'smoke-room', folderId: 'smoke-folder', meetingId: 'smoke-meeting' });

const chunk = 8000;
const started = Date.now();
for (let seq = 0, at = 0; at < samples.length; seq++, at += chunk) {
  await session.push(seq, at / 16000, samples.subarray(at, at + chunk));
}
await session.finish();
await session.settle(10_000);

const names = new Map<string, string>();
for (const caption of session.captionsSince(0).captions) {
  const who = caption.speakerKey ? (names.get(caption.speakerKey) ?? names.set(caption.speakerKey, `Speaker ${names.size + 1}`).get(caption.speakerKey)!) : '(none)';
  console.log(`[${caption.atSec.toFixed(1)}–${caption.endSec.toFixed(1)}] ${who.padEnd(10)} ${caption.lang}: ${caption.text}`);
}
console.log(`\n${names.size} live speakers, ${((Date.now() - started) / 1000).toFixed(1)} s for ${(samples.length / 16000).toFixed(1)} s of audio`);
process.exit(0);
