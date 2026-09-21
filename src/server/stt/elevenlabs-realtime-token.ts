/**
 * ElevenLabs realtime token provider. Mints a single-use `realtime_scribe`
 * token so the iframe SDK never sees `ELEVENLABS_API_KEY`. ElevenLabs realtime
 * has NO live speaker diarization, so choosing it disables live speaker naming
 * for that meeting (D-18) — `capabilities.speakerLabels` is fixed `false`
 * regardless of anything the vendor response contains.
 */
import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import { probeElevenLabsAccount } from './provider-health-probe.js';
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
      throw new AppError('Missing ELEVENLABS_API_KEY — cannot mint an ElevenLabs live-caption token.');
    }

    let response: Response;
    try {
      response = await fetch(SINGLE_USE_TOKEN_URL, {
        method: 'POST',
        headers: { 'xi-api-key': env.elevenLabsApiKey, 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      throw new AppError('Could not connect to ElevenLabs to fetch a live-caption token.');
    }
    if (!response.ok) {
      throw new AppError(`ElevenLabs refused to issue a live-caption token (HTTP ${response.status}).`);
    }

    const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === 'string' ? body.token : undefined;
    if (!token) throw new AppError('ElevenLabs returned an invalid token.');

    return {
      provider: 'elevenlabs',
      token,
      expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
      model: env.elevenLabsRealtimeModel,
      capabilities: CAPABILITIES,
    };
  },

  async status(): Promise<ProviderStatus> {
    const probe = await probeElevenLabsAccount();
    return {
      provider: 'elevenlabs',
      kind: 'realtime',
      configured: probe.reason !== 'not_configured',
      ok: probe.ok,
      models: [env.elevenLabsRealtimeModel],
      detail: probe.ok ? undefined : probe.reason === 'not_configured' ? 'Missing ELEVENLABS_API_KEY.' : 'Could not connect to ElevenLabs.',
      reason: probe.ok ? undefined : probe.reason,
      usage: probe.usage,
    };
  },
};
