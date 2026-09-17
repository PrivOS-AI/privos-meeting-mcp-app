/**
 * ElevenLabs batch (scribe_v2) transcription provider (shell). Needs decoded
 * 16k wav, `diarize:true`, word timestamps and `diarization_threshold` from env.
 * Real round-trip lands in P3.
 */
import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import type { AsyncSttProvider, ProviderStatus, SttResult, TranscribeInput } from './stt-provider.js';

export const elevenLabsBatchProvider: AsyncSttProvider = {
  vendor: 'elevenlabs',

  async transcribeFile(_input: TranscribeInput): Promise<SttResult> {
    throw new AppError('elevenlabs-batch: transcribeFile chưa được triển khai (Phase 3).');
  },

  async status(): Promise<ProviderStatus> {
    const configured = Boolean(env.elevenLabsApiKey);
    return {
      provider: 'elevenlabs',
      kind: 'async',
      configured,
      ok: configured,
      models: [env.elevenLabsBatchModel],
      detail: configured ? undefined : 'Thiếu ELEVENLABS_API_KEY.',
    };
  },
};
