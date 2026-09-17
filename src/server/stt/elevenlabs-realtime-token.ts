/**
 * ElevenLabs realtime token provider (shell). Mints a single-use realtime_scribe
 * token. ElevenLabs realtime has NO live speaker labels, so choosing it disables
 * live speaker naming for that meeting (QĐ-18). Real minting lands in P2.
 */
import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import type { ProviderStatus, RealtimeCapabilities, RealtimeToken, RealtimeTokenProvider } from './stt-provider.js';

export const elevenLabsRealtimeProvider: RealtimeTokenProvider = {
  vendor: 'elevenlabs',
  capabilities: { speakerLabels: false, translation: false } as RealtimeCapabilities,

  async mint(_meetingId: string): Promise<RealtimeToken> {
    throw new AppError('elevenlabs-realtime: mint chưa được triển khai (Phase 2).');
  },

  async status(): Promise<ProviderStatus> {
    const configured = Boolean(env.elevenLabsApiKey);
    return {
      provider: 'elevenlabs',
      kind: 'realtime',
      configured,
      ok: configured,
      models: [env.elevenLabsRealtimeModel],
      detail: configured ? undefined : 'Thiếu ELEVENLABS_API_KEY.',
    };
  },
};
