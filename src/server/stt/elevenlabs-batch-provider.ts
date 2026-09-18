/**
 * ElevenLabs batch (`scribe_v2`) transcription. A single `speechToText.convert`
 * call streamed from disk via `fs.createReadStream` (spec default) — no
 * upload/poll/cleanup-remote round trip, unlike Soniox async. Requires the
 * DECODED 16k mono wav (job runs `decode-audio.ts` before this for every
 * provider anyway, since P4 embedding needs it too).
 */
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

import { ElevenLabsClient, ElevenLabsError } from '@elevenlabs/elevenlabs-js';

import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import { probeElevenLabsAccount } from './provider-health-probe.js';
import type { AsyncSttProvider, ProviderStatus, SttResult, SttToken, TranscribeInput } from './stt-provider.js';

const RETRY_ATTEMPTS = 3;

interface ElevenWord {
  text: string;
  start?: number;
  end?: number;
  type: 'word' | 'spacing' | 'audio_event';
  speakerId?: string;
  logprob: number;
}

/**
 * Drops `spacing`-type words (spec: "bỏ type==='spacing' khi tính biên" —
 * they carry no speaker/segment-boundary information and would otherwise
 * force `segment-builder.ts`'s "missing speaker inherits the previous
 * token's" rule to run on whitespace). Keeps `audio_event` as bracketed text
 * (`[laughter]`), maps `speaker_id`->`speaker`, `logprob`->`confidence`
 * (converted from log-space via `exp`), seconds->ms.
 */
function mapWordsToTokens(words: readonly ElevenWord[]): SttToken[] {
  const tokens: SttToken[] = [];
  for (const word of words) {
    if (word.type === 'spacing') continue;
    const startMs = Math.round((word.start ?? 0) * 1000);
    const endMs = Math.round((word.end ?? word.start ?? 0) * 1000);
    tokens.push({
      text: word.type === 'audio_event' ? `[${word.text}]` : word.text,
      startMs,
      endMs,
      speaker: word.speakerId,
      confidence: Number.isFinite(word.logprob) ? Math.exp(word.logprob) : undefined,
      isFinal: true,
    });
  }
  return tokens;
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status >= 500 || status === 429;
}

async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      const retryable = !(error instanceof ElevenLabsError) || isRetryableStatus(error.statusCode);
      if (!retryable || attempt === RETRY_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new AppError(String(lastError));
}

export const elevenLabsBatchProvider: AsyncSttProvider = {
  vendor: 'elevenlabs',

  async transcribeFile(input: TranscribeInput): Promise<SttResult> {
    if (!env.elevenLabsApiKey) throw new AppError('Thiếu ELEVENLABS_API_KEY — không chạy được elevenlabs-batch.');
    const client = new ElevenLabsClient({ apiKey: env.elevenLabsApiKey });
    const languageCode = input.languageHints?.[0];

    let response;
    try {
      response = await withRetry(
        () =>
          client.speechToText.convert(
            {
              modelId: env.elevenLabsBatchModel,
              file: { data: createReadStream(input.audioPath), filename: basename(input.audioPath), contentType: 'audio/wav' },
              diarize: true,
              diarizationThreshold: env.elevenLabsDiarizationThreshold,
              timestampsGranularity: 'word',
              tagAudioEvents: true,
              ...(languageCode ? { languageCode } : {}),
            },
            { abortSignal: input.signal, maxRetries: 0 },
          ),
        input.signal,
      );
    } catch (error) {
      if (error instanceof ElevenLabsError) {
        throw new AppError(`ElevenLabs xử lý thất bại (HTTP ${error.statusCode ?? '?'}): ${error.message}`);
      }
      throw error;
    }

    const tokens = mapWordsToTokens(response.words as ElevenWord[]);
    return { tokens, segments: [], language: response.languageCode };
  },

  async status(): Promise<ProviderStatus> {
    const probe = await probeElevenLabsAccount();
    return {
      provider: 'elevenlabs',
      kind: 'async',
      configured: probe.reason !== 'not_configured',
      ok: probe.ok,
      models: [env.elevenLabsBatchModel],
      detail: probe.ok ? undefined : probe.reason === 'not_configured' ? 'Thiếu ELEVENLABS_API_KEY.' : 'Không kết nối được tới ElevenLabs.',
      reason: probe.ok ? undefined : probe.reason,
      usage: probe.usage,
    };
  },
};

export { mapWordsToTokens };
export type { ElevenWord };
