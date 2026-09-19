/**
 * Cheap, real "is this vendor account usable right now" probes — one call per
 * vendor, never a full transcription, never logs or returns the key itself
 * (plan.md § STT status tool). Shared by all four provider `status()`
 * implementations so `meeting_stt_status`'s "Check connection" reflects a real
 * round trip instead of just "an env var is set".
 *
 * Soniox: mint a temporary key with a 10s TTL and let it expire unused — the
 * cheapest documented call that still proves the key is accepted server-side
 * (same endpoint `soniox-realtime-token.ts` already mints real tokens from).
 * ElevenLabs: `GET /v1/user/subscription` — read-only account info, also the
 * source of the usage figures the status table shows (tier/characterCount/
 * characterLimit).
 */
import { env } from '../env.js';
import type { ProviderStatusReason, ProviderUsage } from './stt-provider.js';

export interface ProbeResult {
  ok: boolean;
  reason?: ProviderStatusReason;
  usage?: ProviderUsage;
}

const PROBE_TIMEOUT_MS = 8_000;

function reasonForHttpStatus(status: number): ProviderStatusReason {
  return status === 401 || status === 403 ? 'invalid_key' : 'http_error';
}

export async function probeSonioxAccount(): Promise<ProbeResult> {
  if (!env.sonioxApiKey) return { ok: false, reason: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.sonioxApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 10, single_use: true }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: reasonForHttpStatus(response.status) };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeElevenLabsAccount(): Promise<ProbeResult> {
  if (!env.elevenLabsApiKey) return { ok: false, reason: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': env.elevenLabsApiKey },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: reasonForHttpStatus(response.status) };
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const usage: ProviderUsage = {
      tier: typeof body?.tier === 'string' ? body.tier : undefined,
      characterCount: typeof body?.character_count === 'number' ? body.character_count : undefined,
      characterLimit: typeof body?.character_limit === 'number' ? body.character_limit : undefined,
    };
    return { ok: true, usage };
  } catch {
    return { ok: false, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
