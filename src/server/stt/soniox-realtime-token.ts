/**
 * Soniox realtime token provider. Mints a single-use temporary key so the
 * iframe SDK never sees `SONIOX_API_KEY`. Field names (`api_key`/`expires_at`)
 * follow the plan's documented sketch (plan.md § "Tool mint token realtime");
 * open question #2 flags that no live call has confirmed them yet — if a real
 * response uses different casing, only the two `typeof body?.x` reads below
 * need to change.
 */
import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import { probeSonioxAccount } from './provider-health-probe.js';
import type { ProviderStatus, RealtimeCapabilities, RealtimeToken, RealtimeTokenProvider } from './stt-provider.js';

const TEMP_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key';
/** Fixed realtime endpoint (also declared in the manifest CSP connect-src). */
export const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
/** Vendor hard cap is 300 min/session; this leaves headroom past our ~280 min proactive roll-over. */
const MAX_SESSION_DURATION_SECONDS = 16_800;

const CAPABILITIES: RealtimeCapabilities = { speakerLabels: true, translation: true };

export const sonioxRealtimeProvider: RealtimeTokenProvider = {
  vendor: 'soniox',
  // Soniox realtime is the only provider with live speaker diarization (D-18)
  // and offers native two-way translation.
  capabilities: CAPABILITIES,

  async mint(meetingId: string): Promise<RealtimeToken> {
    if (!env.sonioxApiKey) {
      throw new AppError('Missing SONIOX_API_KEY — cannot mint a Soniox live-caption token.');
    }
    const expiresInSeconds = Math.min(env.sonioxTempKeyTtlSec, 3600);

    let response: Response;
    try {
      response = await fetch(TEMP_KEY_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.sonioxApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          usage_type: 'transcribe_websocket',
          expires_in_seconds: expiresInSeconds,
          single_use: true,
          max_session_duration_seconds: MAX_SESSION_DURATION_SECONDS,
          client_reference_id: meetingId,
        }),
      });
    } catch {
      throw new AppError('Could not connect to Soniox to fetch a live-caption token.');
    }
    if (!response.ok) {
      throw new AppError(`Soniox refused to issue a live-caption token (HTTP ${response.status}).`);
    }

    const body = (await response.json().catch(() => null)) as { api_key?: unknown; expires_at?: unknown } | null;
    const apiKey = typeof body?.api_key === 'string' ? body.api_key : undefined;
    if (!apiKey) throw new AppError('Soniox returned an invalid token.');
    const expiresAt =
      typeof body?.expires_at === 'string' ? body.expires_at : new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    return {
      provider: 'soniox',
      token: apiKey,
      wsUrl: SONIOX_WS_URL,
      expiresAt,
      model: env.sonioxRtModel,
      capabilities: CAPABILITIES,
    };
  },

  async status(): Promise<ProviderStatus> {
    const probe = await probeSonioxAccount();
    return {
      provider: 'soniox',
      kind: 'realtime',
      configured: probe.reason !== 'not_configured',
      ok: probe.ok,
      models: [env.sonioxRtModel],
      detail: probe.ok ? undefined : probe.reason === 'not_configured' ? 'Missing SONIOX_API_KEY.' : 'Could not connect to Soniox.',
      reason: probe.ok ? undefined : probe.reason,
    };
  },
};
