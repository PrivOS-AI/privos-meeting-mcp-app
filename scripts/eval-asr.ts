/**
 * Recognition quality under bad capture: runs WAVs through several models,
 * decoding methods and input clean-ups, on clean audio and on the same audio
 * made quiet and/or noisy, and prints word error rates.
 *
 *   npx tsx scripts/eval-asr.ts <models dir>
 *
 * `<models dir>` holds sherpa-onnx model folders (as released). English uses
 * the references in its `test_wavs/trans.txt`. The Vietnamese test files have
 * none, so their reference is the strongest setup's output on CLEAN audio: the
 * Vietnamese numbers measure how much survives bad capture, not absolute WER.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ffmpeg from '@ffmpeg-installer/ffmpeg';
import sherpa from 'sherpa-onnx-node';

const RATE = 16000;
const root = process.argv[2];
if (!root) {
  console.error('usage: eval-asr.ts <models dir>');
  process.exit(2);
}

interface ModelSpec {
  name: string;
  dir: string;
  encoder: string;
  decoder: string;
  joiner: string;
}

const VI_MODELS: ModelSpec[] = [
  { name: 'vi-30M-int8 (now)', dir: 'sherpa-onnx-zipformer-vi-30M-int8-2026-02-09', encoder: 'encoder.int8.onnx', decoder: 'decoder.onnx', joiner: 'joiner.int8.onnx' },
  { name: 'vi-70kh-int8', dir: 'sherpa-onnx-zipformer-vi-int8-2025-04-20', encoder: 'encoder-epoch-12-avg-8.int8.onnx', decoder: 'decoder-epoch-12-avg-8.onnx', joiner: 'joiner-epoch-12-avg-8.int8.onnx' },
  { name: 'vi-70kh-fp32', dir: 'sherpa-onnx-zipformer-vi-2025-04-20', encoder: 'encoder-epoch-12-avg-8.onnx', decoder: 'decoder-epoch-12-avg-8.onnx', joiner: 'joiner-epoch-12-avg-8.onnx' },
].filter((m) => existsSync(path.join(root, m.dir)));

const EN_MODEL: ModelSpec = {
  name: 'en-small-int8',
  dir: 'sherpa-onnx-zipformer-small-en-2023-06-26',
  encoder: 'encoder-epoch-99-avg-1.int8.onnx',
  decoder: 'decoder-epoch-99-avg-1.int8.onnx',
  joiner: 'joiner-epoch-99-avg-1.int8.onnx',
};

type Decoding = 'greedy_search' | 'modified_beam_search';

function recognizer(model: ModelSpec, decoding: Decoding) {
  const d = path.join(root, model.dir);
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(d, model.encoder), decoder: path.join(d, model.decoder), joiner: path.join(d, model.joiner) },
      tokens: path.join(d, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: decoding,
    maxActivePaths: 4,
  } as never);
}

function decode(rec: ReturnType<typeof recognizer>, samples: Float32Array): string {
  const stream = rec.createStream();
  stream.acceptWaveform({ samples, sampleRate: RATE });
  rec.decode(stream);
  return rec.getResult(stream).text.trim();
}

// ---- conditions ----

let seed = 1;
function noise(): number {
  // Deterministic Box–Muller, so every setup hears the same noise.
  seed = (seed * 16807) % 2147483647;
  const u = seed / 2147483647;
  seed = (seed * 16807) % 2147483647;
  const v = seed / 2147483647;
  return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * v);
}

const rms = (s: Float32Array) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / Math.max(1, s.length));

function quiet(s: Float32Array, db = -28): Float32Array {
  const g = 10 ** (db / 20);
  return s.map((x) => x * g);
}

function noisy(s: Float32Array, snrDb = 10): Float32Array {
  seed = 7;
  const level = rms(s) / 10 ** (snrDb / 20);
  return s.map((x) => x + noise() * level);
}

/** `HARSH=1`: conditions closer to a far microphone in a noisy room. */
const CONDITIONS: Record<string, (s: Float32Array) => Float32Array> = process.env.HARSH
  ? {
      clean: (s) => s,
      'quiet -40dB': (s) => quiet(s, -40),
      'noise SNR5': (s) => noisy(s, 5),
      'noise SNR0': (s) => noisy(s, 0),
      'quiet+SNR5': (s) => noisy(quiet(s, -35), 5),
    }
  : {
      clean: (s) => s,
      'quiet -28dB': (s) => quiet(s),
      'noise SNR10': (s) => noisy(s),
      'quiet+noise': (s) => noisy(quiet(s), 12),
    };

// ---- input clean-ups ----

/** Speech level to about -20 dBFS (at most +30 dB), peaks kept under 0.95. */
function normalize(s: Float32Array): Float32Array {
  const level = rms(s);
  if (level < 1e-6) return s;
  const gain = Math.min(10 ** (30 / 20), 0.1 / level);
  const peak = s.reduce((m, x) => Math.max(m, Math.abs(x)), 0) * gain;
  const g = peak > 0.95 ? gain * (0.95 / peak) : gain;
  return s.map((x) => x * g);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'eval-asr-'));
function writeWav(file: string, s: Float32Array): void {
  const data = Buffer.alloc(44 + s.length * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + s.length * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(RATE, 24);
  data.writeUInt32LE(RATE * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(s.length * 2, 40);
  s.forEach((x, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), 44 + i * 2));
  writeFileSync(file, data);
}

export const SPEECH_FILTER = 'highpass=f=70,lowpass=f=7600,afftdn=nr=12:nf=-35,dynaudnorm=f=200:g=11:p=0.9:m=30';

function ffmpegClean(s: Float32Array): Float32Array {
  const input = path.join(tmp, 'in.wav');
  const output = path.join(tmp, 'out.wav');
  writeWav(input, s);
  execFileSync(ffmpeg.path, ['-y', '-loglevel', 'error', '-i', input, '-af', SPEECH_FILTER, '-ac', '1', '-ar', String(RATE), output]);
  return sherpa.readWave(output).samples;
}

const CLEANUPS: Record<string, (s: Float32Array) => Float32Array> = { raw: (s) => s, normalize, ffmpeg: ffmpegClean };

// ---- scoring ----

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function wer(ref: string, hyp: string): number {
  const r = words(ref);
  const h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? d[r.length][h.length] / r.length : 0;
}

function load(dir: string, files: string[]): Float32Array[] {
  return files.map((f) => sherpa.readWave(path.join(root, dir, 'test_wavs', f)).samples);
}

function table(title: string, rows: Array<[string, Record<string, number>]>): void {
  console.log(`\n${title}`);
  const cols = Object.keys(CONDITIONS);
  console.log(['setup'.padEnd(40), ...cols.map((c) => c.padStart(12))].join(''));
  for (const [name, byCond] of rows) console.log([name.padEnd(40), ...cols.map((c) => `${(byCond[c] * 100).toFixed(1)}%`.padStart(12))].join(''));
}

// ---- English: real references ----
const enRefs = readFileSync(path.join(root, EN_MODEL.dir, 'test_wavs', 'trans.txt'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => l.split(' ').slice(1).join(' '))
  .slice(0, 2);
// The third English file is 8 kHz; only the two 16 kHz ones are scored.
const enWavs = load(EN_MODEL.dir, ['0.wav', '1.wav']);
const enRows: Array<[string, Record<string, number>]> = [];
for (const decoding of ['greedy_search', 'modified_beam_search'] as Decoding[]) {
  const rec = recognizer(EN_MODEL, decoding);
  for (const [cleanName, cleanup] of Object.entries(CLEANUPS)) {
    const byCond: Record<string, number> = {};
    for (const [condName, cond] of Object.entries(CONDITIONS)) {
      byCond[condName] = enWavs.reduce((sum, w, i) => sum + wer(enRefs[i], decode(rec, cleanup(cond(w)))), 0) / enWavs.length;
    }
    enRows.push([`${EN_MODEL.name} ${decoding === 'greedy_search' ? 'greedy' : 'beam4'} ${cleanName}`, byCond]);
  }
}
table('ENGLISH — WER against the published references', enRows);

// ---- Vietnamese: survival under bad capture ----
const viWavs = load(VI_MODELS[0].dir, ['0.wav', '1.wav', '2.wav']);
const best = VI_MODELS.at(-1)!;
const refRec = recognizer(best, 'modified_beam_search');
const viRefs = viWavs.map((w) => decode(refRec, w));
console.log(`\nVIETNAMESE reference = ${best.name} beam4 on clean audio:`);
viRefs.forEach((r, i) => console.log(`  ${i}.wav: ${r}`));

const viRows: Array<[string, Record<string, number>]> = [];
const timing: string[] = [];
for (const model of VI_MODELS) {
  for (const decoding of ['greedy_search', 'modified_beam_search'] as Decoding[]) {
    const rec = recognizer(model, decoding);
    const started = Date.now();
    const cleanTexts = viWavs.map((w) => decode(rec, w));
    timing.push(`${model.name} ${decoding}: ${(Date.now() - started) / 1000}s for ${(viWavs.reduce((a, w) => a + w.length, 0) / RATE).toFixed(1)}s audio`);
    if (decoding === 'modified_beam_search') cleanTexts.forEach((t, i) => console.log(`  ${model.name}: ${i}.wav: ${t}`));
    for (const [cleanName, cleanup] of Object.entries(CLEANUPS)) {
      const byCond: Record<string, number> = {};
      for (const [condName, cond] of Object.entries(CONDITIONS)) {
        byCond[condName] = viWavs.reduce((sum, w, i) => sum + wer(viRefs[i], decode(rec, cleanup(cond(w)))), 0) / viWavs.length;
      }
      viRows.push([`${model.name} ${decoding === 'greedy_search' ? 'greedy' : 'beam4'} ${cleanName}`, byCond]);
    }
  }
}
table('VIETNAMESE — difference from the clean reference (lower = more survives)', viRows);
console.log(`\nSPEED (clean, 2 threads):\n  ${timing.join('\n  ')}`);
process.exit(0);
