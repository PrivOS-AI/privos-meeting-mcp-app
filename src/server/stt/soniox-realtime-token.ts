/**
 * Soniox realtime token provider (shell). Mints a temporary transcribe-websocket
 * key for the iframe SDK. Real minting + limits land in P2 (spike P1-8/P1-10).
 */
import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import type { ProviderStatus, RealtimeCapabilities, RealtimeToken, RealtimeTokenProvider } from './stt-provider.js';

export const sonioxRealtimeProvider: RealtimeTokenProvider = {
  vendor: 'soniox',
  // Soniox realtime is the only provider with live speaker diarization (QĐ-18)
  // and offers native two-way translation.
  capabilities: { speakerLabels: true, translation: true } as RealtimeCapabilities,

  async mint(_meetingId: string): Promise<RealtimeToken> {
    throw new AppError('soniox-realtime: mint chưa được triển khai (Phase 2).');
  },

  async status(): Promise<ProviderStatus> {
    const configured = Boolean(env.sonioxApiKey);
    return {
      provider: 'soniox',
      kind: 'realtime',
      configured,
      ok: configured,
      models: [env.sonioxRtModel],
      detail: configured ? undefined : 'Thiếu SONIOX_API_KEY.',
    };
  },
};
