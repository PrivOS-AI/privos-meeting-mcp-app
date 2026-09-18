/**
 * ElevenLabs realtime token provider. Mints a single-use `realtime_scribe`
 * token so the iframe SDK never sees `ELEVENLABS_API_KEY`. ElevenLabs realtime
 * has NO live speaker diarization, so choosing it disables live speaker naming
 * for that meeting (QĐ-18) — `capabilities.speakerLabels` is fixed `false`
 * regardless of anything the vendor response contains.
 */
import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import type { ProviderStatus, RealtimeCapabilities, RealtimeToken, RealtimeTokenProvider } from './stt-provider.js';

const SINGLE_USE_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe';
/** Docs describe the token as single-use, consumed at first connect, ~15 min TTL if unused. */
const TOKEN_TTL_SECONDS = 15 * 60;

const CAPABILITIES: RealtimeCapabilities = { speakerLabels: false, translation: false };

export const elevenLabsRealtimeProvider: RealtimeTokenProvider = {
  vendor: 'elevenlabs',
  capabilities: CAPABILITIES,

  async mint(_meetingId: string): Promise<RealtimeToken> {
    if (!env.elevenLabsApiKey) {
      throw new AppError('Thiếu ELEVENLABS_API_KEY — không mint được token phụ đề trực tiếp ElevenLabs.');
    }

    let response: Response;
    try {
      response = await fetch(SINGLE_USE_TOKEN_URL, {
        method: 'POST',
        headers: { 'xi-api-key': env.elevenLabsApiKey, 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      throw new AppError('Không kết nối được tới ElevenLabs để lấy token phụ đề trực tiếp.');
    }
    if (!response.ok) {
      throw new AppError(`ElevenLabs từ chối cấp token phụ đề trực tiếp (HTTP ${response.status}).`);
    }

    const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === 'string' ? body.token : undefined;
    if (!token) throw new AppError('ElevenLabs trả về token không hợp lệ.');

    return {
      provider: 'elevenlabs',
      token,
      expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
      model: env.elevenLabsRealtimeModel,
      capabilities: CAPABILITIES,
    };
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
