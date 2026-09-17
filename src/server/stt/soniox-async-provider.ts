/**
 * Soniox async transcription provider (shell). Uploads finished audio, creates a
 * transcription, polls to completion and normalizes tokens. Real round-trip
 * lands in P3 (spike P1-9 pins the true token field names first).
 */
import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import type { AsyncSttProvider, ProviderStatus, SttResult, TranscribeInput } from './stt-provider.js';

export const sonioxAsyncProvider: AsyncSttProvider = {
  vendor: 'soniox',

  async transcribeFile(_input: TranscribeInput): Promise<SttResult> {
    throw new AppError('soniox-async: transcribeFile chưa được triển khai (Phase 3).');
  },

  async status(): Promise<ProviderStatus> {
    const configured = Boolean(env.sonioxApiKey);
    return {
      provider: 'soniox',
      kind: 'async',
      configured,
      ok: configured,
      models: [env.sonioxAsyncModel],
      detail: configured ? undefined : 'Thiếu SONIOX_API_KEY.',
    };
  },
};
