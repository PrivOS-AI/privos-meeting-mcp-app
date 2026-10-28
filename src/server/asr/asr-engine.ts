/**
 * Self-hosted speech recognition (sherpa-onnx, CPU) — the `local` provider's
 * engine, used live (`live-asr-session.ts`) and post-meeting
 * (`stt/local-async-provider.ts`). Nothing leaves the container.
 *
 * Mixed Vietnamese/English meetings: every utterance is decoded by BOTH the
 * Vietnamese and the English Zipformer (`decodeAsync`, off the event loop) and
 * the result with the higher mean token log-probability wins — on the spike
 * (docs/PLAN-local-stt.md §8) the right model scored ≥ 0.25 higher on every
 * sample, better than Whisper-tiny language ID, which mislabelled Vietnamese
 * as zh/th and runs synchronously. A small bias keeps a close call Vietnamese.
 *
 * Models are baked into the image under `ASR_MODEL_DIR` (default
 * `models/asr`) and loaded lazily, once per process; a load failure is a
 * catchable AppError and does not poison the singleton.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { AppError } from '../../shared/app-error.js';
import type { OfflineRecognizer, OfflineRecognizerConfig, Vad } from 'sherpa-onnx-node';

export const SAMPLE_RATE = 16000;
/** A close call stays Vietnamese: English must score this much higher (mean log-prob per token). */
const ENGLISH_MARGIN = 0.05;

export type AsrLanguage = 'vi' | 'en';

export interface AsrWord {
  /** The word, with a leading space when it starts a new word (tokens carry their own spacing). */
  text: string;
  startSec: number;
  endSec: number;
}

export interface AsrUtterance {
  lang: AsrLanguage;
  /** Sentence-cased text of the whole utterance. */
  text: string;
  words: AsrWord[];
  /** exp(mean token log-prob), 0–1. */
  confidence: number;
}

export function asrModelDir(): string {
  return path.resolve(process.env.ASR_MODEL_DIR || 'models/asr');
}

/** Every file the local provider needs, relative to `asrModelDir()`. */
export const ASR_MODEL_FILES = {
  vi: { encoder: 'vi/encoder.int8.onnx', decoder: 'vi/decoder.onnx', joiner: 'vi/joiner.int8.onnx', tokens: 'vi/tokens.txt' },
  en: { encoder: 'en/encoder.int8.onnx', decoder: 'en/decoder.int8.onnx', joiner: 'en/joiner.int8.onnx', tokens: 'en/tokens.txt' },
  vad: 'silero_vad.onnx',
  segmentation: 'segmentation/model.onnx',
} as const;

function flatFiles(): string[] {
  const { vi, en, vad, segmentation } = ASR_MODEL_FILES;
  return [...Object.values(vi), ...Object.values(en), vad, segmentation];
}

/** Which model files are missing — empty when the local provider can run. */
export function missingAsrModels(): string[] {
  const dir = asrModelDir();
  return flatFiles().filter((file) => !existsSync(path.join(dir, file)));
}

type SherpaModule = typeof import('sherpa-onnx-node').default;
let sherpaModule: Promise<SherpaModule> | null = null;

async function sherpa(): Promise<SherpaModule> {
  sherpaModule ??= import('sherpa-onnx-node')
    .then((imported) => (imported as unknown as { default: SherpaModule }).default)
    .catch((error: unknown) => {
      sherpaModule = null;
      throw new AppError(`Could not load sherpa-onnx-node: ${error instanceof Error ? error.message : String(error)}`, 'PROVIDER_UNAVAILABLE');
    });
  return sherpaModule;
}

function recognizerConfig(files: { encoder: string; decoder: string; joiner: string; tokens: string }): OfflineRecognizerConfig {
  const dir = asrModelDir();
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(dir, files.encoder), decoder: path.join(dir, files.decoder), joiner: path.join(dir, files.joiner) },
      tokens: path.join(dir, files.tokens),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    // Beam search over 4 paths: fewer word errors than greedy for a small extra cost (scripts/eval-asr.ts).
    decodingMethod: 'modified_beam_search',
    maxActivePaths: 4,
  };
}

/** Target speech level (~-20 dBFS RMS) and the most an utterance is boosted (+30 dB). */
const TARGET_RMS = 0.1;
const MAX_GAIN = 10 ** (30 / 20);

/**
 * Brings an utterance to a steady speech level before recognition: a far or quiet microphone
 * otherwise reaches the model barely above silence (an English clip at -40 dB went from 96 % to
 * 2 % word errors with this, scripts/eval-asr.ts). Peaks stay under 0.95; silence is left alone.
 */
export function normalizeLevel(samples: Float32Array): Float32Array {
  let energy = 0;
  let peak = 0;
  for (const x of samples) {
    energy += x * x;
    peak = Math.max(peak, Math.abs(x));
  }
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  if (rms < 1e-5 || peak === 0) return samples;
  const gain = Math.min(MAX_GAIN, TARGET_RMS / rms, 0.95 / peak);
  if (Math.abs(gain - 1) < 0.05) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

const recognizers = new Map<AsrLanguage, Promise<OfflineRecognizer>>();

async function recognizer(lang: AsrLanguage): Promise<OfflineRecognizer> {
  let pending = recognizers.get(lang);
  if (!pending) {
    const missing = missingAsrModels();
    if (missing.length) {
      throw new AppError(`Speech recognition models are missing from the image: ${missing.join(', ')}.`, 'PROVIDER_NOT_CONFIGURED');
    }
    pending = sherpa().then((mod) => mod.OfflineRecognizer.createAsync(recognizerConfig(ASR_MODEL_FILES[lang])));
    pending.catch(() => recognizers.delete(lang));
    recognizers.set(lang, pending);
  }
  return pending;
}

/** A streaming Silero VAD (one per live session; cheap to create). */
export async function createVad(): Promise<Vad> {
  const mod = await sherpa();
  return new mod.Vad(
    {
      sileroVad: {
        model: path.join(asrModelDir(), ASR_MODEL_FILES.vad),
        threshold: 0.5,
        minSilenceDuration: 0.4,
        minSpeechDuration: 0.25,
        windowSize: 512,
        // A live caption is final only once its utterance ends; a monologue is cut at 10 s so it never waits longer.
        maxSpeechDuration: 10,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      debug: 0,
    },
    60,
  );
}

interface Decoded {
  lang: AsrLanguage;
  tokens: string[];
  timestamps: number[];
  meanLogProb: number;
}

async function decodeWith(lang: AsrLanguage, samples: Float32Array): Promise<Decoded> {
  const rec = await recognizer(lang);
  const stream = rec.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  await rec.decodeAsync(stream);
  const result = rec.getResult(stream);
  const logProbs = result.ys_log_probs ?? [];
  const meanLogProb = logProbs.length ? logProbs.reduce((sum, v) => sum + v, 0) / logProbs.length : Number.NEGATIVE_INFINITY;
  return { lang, tokens: result.tokens ?? [], timestamps: result.timestamps ?? [], meanLogProb };
}

/** Picks the language whose model fits the audio best (see the module comment). */
export function pickLanguage(vi: { meanLogProb: number }, en: { meanLogProb: number }): AsrLanguage {
  return en.meanLogProb > vi.meanLogProb + ENGLISH_MARGIN ? 'en' : 'vi';
}

/**
 * Groups BPE tokens into words: a token starting with a space (or the first
 * token) opens a word. Times are absolute (`offsetSec` + token time); a word
 * ends where the next one starts, the last one at `offsetSec + durationSec`.
 */
export function tokensToWords(tokens: readonly string[], timestamps: readonly number[], offsetSec: number, durationSec: number): AsrWord[] {
  const words: AsrWord[] = [];
  tokens.forEach((token, i) => {
    const at = offsetSec + (timestamps.at(i) ?? 0);
    const opens = words.length === 0 || token.startsWith(' ');
    if (opens) words.push({ text: ` ${token.trim()}`, startSec: at, endSec: at });
    else words[words.length - 1].text += token.trim();
  });
  words.forEach((word, i) => {
    word.endSec = i + 1 < words.length ? words[i + 1].startSec : offsetSec + durationSec;
  });
  return words.filter((word) => word.text.trim().length > 0);
}

/** Model output is upper-case: lower-case it, then capitalise the first word. */
export function sentenceCase(words: AsrWord[], lang: AsrLanguage): AsrWord[] {
  const locale = lang === 'vi' ? 'vi' : 'en';
  return words.map((word, i) => {
    const lower = word.text.toLocaleLowerCase(locale);
    if (i !== 0) return { ...word, text: lower };
    const at = lower.search(/\S/);
    return { ...word, text: at < 0 ? lower : lower.slice(0, at) + lower.charAt(at).toLocaleUpperCase(locale) + lower.slice(at + 1) };
  });
}

/** Recognises one utterance (a VAD segment) that starts at `offsetSec` on the caller's clock. */
export async function recognizeUtterance(raw: Float32Array, offsetSec = 0): Promise<AsrUtterance> {
  const samples = normalizeLevel(raw);
  const [vi, en] = await Promise.all([decodeWith('vi', samples), decodeWith('en', samples)]);
  const best = pickLanguage(vi, en) === 'en' ? en : vi;
  const words = sentenceCase(tokensToWords(best.tokens, best.timestamps, offsetSec, samples.length / SAMPLE_RATE), best.lang);
  return {
    lang: best.lang,
    text: words.map((word) => word.text).join('').trim(),
    words,
    confidence: Number.isFinite(best.meanLogProb) ? Math.exp(best.meanLogProb) : 0,
  };
}

/**
 * A draft of speech still in progress, for a live caption shown while the person is talking.
 * Decoded with ONE model (the language the meeting last used) — half the cost of
 * `recognizeUtterance`, which decides the language once the utterance is complete.
 */
export async function recognizeDraft(raw: Float32Array, lang: AsrLanguage): Promise<string> {
  const samples = normalizeLevel(raw);
  const decoded = await decodeWith(lang, samples);
  return sentenceCase(tokensToWords(decoded.tokens, decoded.timestamps, 0, samples.length / SAMPLE_RATE), lang)
    .map((word) => word.text)
    .join('')
    .trim();
}

/** Loads both recognizers ahead of the first utterance (boot warm-up). Never throws. */
export async function warmUpAsr(): Promise<void> {
  await Promise.all([recognizer('vi'), recognizer('en')]).catch((error: unknown) => {
    console.warn('[asr] warm-up failed:', error instanceof Error ? error.message : error);
  });
}
