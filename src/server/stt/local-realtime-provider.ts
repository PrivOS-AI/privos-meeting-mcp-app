/**
 * `local` realtime provider. There is no vendor and no credential: the iframe
 * pushes audio to `meeting_audio_push` and the container recognises it
 * (`asr/live-asr-session.ts`). `mint` only tells the UI which client to use
 * and what it can expect — captions per utterance, each attributed to a live
 * session speaker on the server (`live-speakers/local-attribution.ts`; the
 * provider itself has no labels), translation through Hub AI (`meeting_translate`).
 */
import { missingAsrModels } from '../asr/asr-engine.js';
import { activeLiveSessionCount } from '../asr/live-asr-session.js';
import type { ProviderStatus, RealtimeCapabilities, RealtimeToken, RealtimeTokenProvider } from './stt-provider.js';

const CAPABILITIES: RealtimeCapabilities = { speakerLabels: false, translation: false, liveSpeakers: true };
const SESSION_HOURS = 6;

export const localRealtimeProvider: RealtimeTokenProvider = {
  vendor: 'local',
  capabilities: CAPABILITIES,

  async mint(meetingId: string): Promise<RealtimeToken> {
    return {
      provider: 'local',
      token: `local:${meetingId}`,
      expiresAt: new Date(Date.now() + SESSION_HOURS * 3_600_000).toISOString(),
      model: 'zipformer-vi+en',
      capabilities: CAPABILITIES,
    };
  },

  async status(): Promise<ProviderStatus> {
    const missing = missingAsrModels();
    return {
      provider: 'local',
      kind: 'realtime',
      configured: missing.length === 0,
      ok: missing.length === 0,
      models: ['zipformer-vi-30M-int8', 'zipformer-small-en-int8', 'silero-vad'],
      activeSessions: activeLiveSessionCount(),
      ...(missing.length ? { detail: `Missing model files: ${missing.join(', ')}.`, reason: 'not_configured' as const } : {}),
    };
  },
};
