/**
 * Why did a meeting come out with an empty transcript? Downloads the meeting's
 * `audio.webm` from Files as the installation bot, decodes it like the job does,
 * and prints the signal level, the VAD speech segments and what the recognizer
 * hears in each — so silence, a too-quiet capture and a recognizer problem can
 * be told apart.
 *
 *   npx tsx scripts/diagnose-local-stt.ts --room <roomId> --folder <meeting folder name>
 *
 * In the image (scripts/ is not shipped; mount it):
 *   docker exec privos-meeting node_modules/.bin/tsx /tmp/diagnose-local-stt.ts --room … --folder 2026-10-27-…
 * Read-only on the Hub. Never prints the credential.
 */
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAgentBotHubClient, loadStandaloneIdentity, readAgentBotCredential, setAdoptedAgentBotCredential } from '@privos_ai/app-server';
import sherpa from 'sherpa-onnx-node';

import { ASR_MODEL_FILES, asrModelDir, recognizeUtterance, SAMPLE_RATE } from '../src/server/asr/asr-engine.js';
import { decodeToWav16k } from '../src/server/media/decode-audio.js';
import { downloadRoomFile, listRoomFolderFiles } from '../src/server/media/hub-file-download.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const roomId = arg('room');
const folderName = arg('folder')?.replace(/^Meetings\//, '');
if (!roomId || !folderName) {
  console.error('usage: diagnose-local-stt.ts --room <roomId> --folder <meeting folder name>');
  process.exit(2);
}

const loaded = loadStandaloneIdentity();
const identity = loaded.identity as { agentBotCredential?: { botUserId: string; token: string } };
const credential = identity.agentBotCredential ?? readAgentBotCredential() ?? undefined;
if (!credential) throw new Error('No agent bot credential.');
setAdoptedAgentBotCredential(credential);
const hub = createAgentBotHubClient({ resolveHubOrigin: async () => loaded.relay.privosUrl });

async function childFolder(name: string, fatherId?: string): Promise<{ _id: string; name: string }> {
  const query = `count=500${fatherId ? `&fatherId=${fatherId}` : ''}`;
  const response = await hub.authorizedFetch(`/api/v1/file-management.folders.channel/${roomId}?${query}`, { method: 'GET', requiredScope: 'files:read' });
  const listed = ((await response.json()) as { folders?: Array<{ _id: string; name: string }> }).folders ?? [];
  const found = listed.find((f) => f.name === name);
  if (!found) throw new Error(`Folder ${name} not found (${listed.length} folders listed).`);
  return found;
}
const folder = await childFolder(folderName, (await childFolder('Meetings'))._id);
const files = await listRoomFolderFiles(hub, roomId, folder._id);
console.log('files:', files.map((f) => f.name).join(', '));
const audio = files.find((f) => f.name === 'audio.webm');
if (!audio) throw new Error('No audio.webm in the folder.');

const scratch = await mkdtemp(path.join(os.tmpdir(), 'diag-stt-'));
const webm = path.join(scratch, 'audio.webm');
const wav = path.join(scratch, 'audio-16k.wav');
await downloadRoomFile(hub, audio._id, webm, new AbortController().signal);
const decoded = await decodeToWav16k(webm, wav, new AbortController().signal);
console.log('decoded:', decoded);

const { samples } = sherpa.readWave(wav);
let peak = 0;
let sum = 0;
for (const s of samples) {
  peak = Math.max(peak, Math.abs(s));
  sum += s * s;
}
const rms = Math.sqrt(sum / Math.max(1, samples.length));
console.log(`duration ${(samples.length / SAMPLE_RATE).toFixed(1)} s · peak ${peak.toFixed(3)} · rms ${rms.toFixed(4)} (${(20 * Math.log10(rms || 1e-9)).toFixed(1)} dBFS)`);
// Per second: level, and zero crossings per second (voiced speech ~200–1500; much higher hints at noise or a
// pitch-shifted capture, e.g. audio recorded at a different sample rate than it is tagged with).
const perSecond: string[] = [];
for (let from = 0; from < samples.length; from += SAMPLE_RATE) {
  const second = samples.subarray(from, from + SAMPLE_RATE);
  let energy = 0;
  let crossings = 0;
  for (let i = 0; i < second.length; i++) {
    energy += second[i] * second[i];
    if (i > 0 && second[i - 1] < 0 !== second[i] < 0) crossings++;
  }
  perSecond.push(`${(20 * Math.log10(Math.sqrt(energy / second.length) || 1e-9)).toFixed(0)}dB/${Math.round((crossings * SAMPLE_RATE) / second.length)}zc`);
}
console.log('per second:', perSecond.join(' '));

for (const threshold of [0.5, 0.3]) {
  const vad = new sherpa.Vad(
    {
      sileroVad: { model: path.join(asrModelDir(), ASR_MODEL_FILES.vad), threshold, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 15 },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      debug: 0,
    },
    60,
  );
  const segments: Array<{ start: number; samples: Float32Array }> = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      segments.push(vad.front(false));
      vad.pop();
    }
  };
  for (let i = 0; i + 512 <= samples.length; i += 512) {
    vad.acceptWaveform(samples.subarray(i, i + 512));
    drain();
  }
  vad.flush();
  drain();
  console.log(`\nVAD threshold ${threshold}: ${segments.length} segment(s)`);
  for (const segment of segments) {
    const at = segment.start / SAMPLE_RATE;
    const heard = await recognizeUtterance(segment.samples, at);
    console.log(`  [${at.toFixed(1)}–${(at + segment.samples.length / SAMPLE_RATE).toFixed(1)}] ${heard.lang} ${heard.confidence.toFixed(2)}: ${heard.text || '(nothing)'}`);
  }
}

// The whole file in one go, VAD bypassed.
const whole = await recognizeUtterance(samples.subarray(0, Math.min(samples.length, SAMPLE_RATE * 30)), 0);
console.log(`\nfirst 30 s without VAD: ${whole.lang}: ${whole.text || '(nothing)'}`);
process.exit(0);
