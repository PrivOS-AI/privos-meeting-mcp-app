/**
 * `local` async provider: the post-meeting transcript, computed in this
 * container. A worker thread finds the speech segments (Silero VAD) and the
 * speaker turns (pyannote segmentation + the speaker-embedding model the
 * voiceprints already use); each segment is then recognised with
 * `recognizeUtterance` (Vietnamese or English, see `asr/asr-engine.ts`) and
 * every word is attributed to the speaker turn it overlaps most.
 *
 * Input is the 16 kHz mono WAV `meeting-job.ts` already decodes.
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { AppError } from '../../shared/app-error.js';
import { ASR_MODEL_FILES, asrModelDir, missingAsrModels, recognizeUtterance, SAMPLE_RATE, type AsrWord } from '../asr/asr-engine.js';
import { env } from '../env.js';
import type { AsyncSttProvider, ProviderStatus, SttResult, SttSegment, SttToken, TranscribeInput } from './stt-provider.js';

/** Clustering cut for the speaker embeddings (sherpa-onnx diarization examples use 0.5 for 3D-Speaker models). */
const CLUSTER_THRESHOLD = Number(process.env.SPEAKER_DIARIZATION_THRESHOLD) || 0.5;

export interface SpeechBoundary {
  startSec: number;
  endSec: number;
}

export interface SpeakerTurn extends SpeechBoundary {
  speaker: number;
}

interface AnalysisResult {
  segments: SpeechBoundary[];
  turns: SpeakerTurn[];
}

function analyse(wavPath: string, diarize: boolean, signal?: AbortSignal): Promise<AnalysisResult> {
  const dir = asrModelDir();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../asr/offline-analysis-worker.mjs', import.meta.url), {
      workerData: {
        wavPath,
        vadModel: path.join(dir, ASR_MODEL_FILES.vad),
        segmentationModel: path.join(dir, ASR_MODEL_FILES.segmentation),
        embeddingModel: path.resolve(env.speakerModelPath),
        diarize,
        clusterThreshold: CLUSTER_THRESHOLD,
      },
    });
    const onAbort = () => {
      void worker.terminate();
      reject(new AppError('Transcription was cancelled.', 'INVALID_STATE'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (message: AnalysisResult | { error: string }) => {
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      if ('error' in message) reject(new AppError(`Local speech analysis failed: ${message.error}`, 'PROVIDER_UNAVAILABLE'));
      else resolve(message);
    });
    worker.once('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new AppError(`Local speech analysis failed: ${error.message}`, 'PROVIDER_UNAVAILABLE'));
    });
  });
}

/** The speaker turn a word overlaps most; the nearest turn when it overlaps none; `null` with no turns at all. */
export function speakerForWord(word: SpeechBoundary, turns: readonly SpeakerTurn[]): number | null {
  if (turns.length === 0) return null;
  let best: SpeakerTurn | null = null;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap = Math.min(word.endSec, turn.endSec) - Math.max(word.startSec, turn.startSec);
    if (overlap > bestOverlap) {
      best = turn;
      bestOverlap = overlap;
    }
  }
  if (best) return best.speaker;
  const mid = (word.startSec + word.endSec) / 2;
  const distance = (turn: SpeakerTurn) => (mid < turn.startSec ? turn.startSec - mid : mid > turn.endSec ? mid - turn.endSec : 0);
  return turns.reduce((nearest, turn) => (distance(turn) < distance(nearest) ? turn : nearest)).speaker;
}

/** Words → normalized tokens (spacing carried in the text), each with its speaker. */
export function wordsToTokens(words: readonly (AsrWord & { lang: string; confidence: number })[], turns: readonly SpeakerTurn[]): SttToken[] {
  return words.map((word) => {
    const speaker = speakerForWord(word, turns);
    return {
      text: word.text,
      startMs: Math.round(word.startSec * 1000),
      endMs: Math.round(word.endSec * 1000),
      speaker: speaker === null ? 'speaker_0' : `speaker_${speaker}`,
      language: word.lang,
      confidence: word.confidence,
      isFinal: true,
    };
  });
}

/** Consecutive same-speaker tokens → segments. */
export function tokensToSegments(tokens: readonly SttToken[]): SttSegment[] {
  const segments: SttSegment[] = [];
  for (const token of tokens) {
    const last = segments.at(-1);
    if (last && last.speaker === token.speaker) {
      last.text += token.text;
      last.endMs = token.endMs;
    } else {
      segments.push({ speaker: token.speaker ?? 'speaker_0', startMs: token.startMs, endMs: token.endMs, text: token.text, language: token.language });
    }
  }
  return segments.map((segment) => ({ ...segment, text: segment.text.trim() }));
}

async function readSamples(wavPath: string): Promise<Float32Array> {
  const sherpa = ((await import('sherpa-onnx-node')) as unknown as { default: typeof import('sherpa-onnx-node').default }).default;
  const wave = sherpa.readWave(wavPath);
  if (wave.sampleRate !== SAMPLE_RATE) throw new AppError(`Expected ${SAMPLE_RATE} Hz audio, got ${wave.sampleRate} Hz.`, 'INVALID_INPUT');
  return wave.samples;
}

export const localAsyncProvider: AsyncSttProvider = {
  vendor: 'local',

  async transcribeFile(input: TranscribeInput): Promise<SttResult> {
    const missing = missingAsrModels();
    if (missing.length) throw new AppError(`Speech recognition models are missing from the image: ${missing.join(', ')}.`, 'PROVIDER_NOT_CONFIGURED');
    if (!input.audioPath.toLowerCase().endsWith('.wav')) throw new AppError('The local provider transcribes the decoded 16 kHz WAV.', 'INVALID_INPUT');

    const { segments, turns } = await analyse(input.audioPath, input.enableSpeakerDiarization !== false, input.signal);
    const samples = await readSamples(input.audioPath);

    const words: (AsrWord & { lang: string; confidence: number })[] = [];
    const languages = new Map<string, number>();
    for (const segment of segments) {
      if (input.signal?.aborted) throw new AppError('Transcription was cancelled.', 'INVALID_STATE');
      const slice = samples.subarray(Math.floor(segment.startSec * SAMPLE_RATE), Math.ceil(segment.endSec * SAMPLE_RATE));
      if (slice.length < SAMPLE_RATE / 10) continue;
      const utterance = await recognizeUtterance(slice, segment.startSec);
      languages.set(utterance.lang, (languages.get(utterance.lang) ?? 0) + utterance.words.length);
      for (const word of utterance.words) words.push({ ...word, lang: utterance.lang, confidence: utterance.confidence });
    }

    const tokens = wordsToTokens(words, turns);
    const language = [...languages].sort((a, b) => b[1] - a[1]).at(0)?.[0];
    return { tokens, segments: tokensToSegments(tokens), ...(language ? { language } : {}) };
  },

  async status(): Promise<ProviderStatus> {
    const missing = missingAsrModels();
    return {
      provider: 'local',
      kind: 'async',
      configured: missing.length === 0,
      ok: missing.length === 0,
      models: ['zipformer-vi-30M-int8', 'zipformer-small-en-int8', 'pyannote-segmentation-3.0'],
      ...(missing.length ? { detail: `Missing model files: ${missing.join(', ')}.`, reason: 'not_configured' as const } : {}),
    };
  },
};
