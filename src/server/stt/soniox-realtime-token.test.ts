import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../env.js';
import { sonioxRealtimeProvider } from './soniox-realtime-token.js';

describe('sonioxRealtimeProvider.mint', () => {
  const originalKey = env.sonioxApiKey;
  const originalTtl = env.sonioxTempKeyTtlSec;

  beforeEach(() => {
    env.sonioxApiKey = 'test-soniox-key';
    env.sonioxTempKeyTtlSec = 900;
  });

  afterEach(() => {
    env.sonioxApiKey = originalKey;
    env.sonioxTempKeyTtlSec = originalTtl;
    vi.restoreAllMocks();
  });

  it('throws a clear error when the vendor key is missing', async () => {
    env.sonioxApiKey = undefined;
    await expect(sonioxRealtimeProvider.mint('meeting-1')).rejects.toThrow(/SONIOX_API_KEY/);
  });

  it('POSTs the documented temporary-key request shape and never logs the key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 900,
        single_use: true,
        max_session_duration_seconds: 16_800,
        client_reference_id: 'meeting-1',
      });
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-soniox-key');
      return {
        ok: true,
        json: async () => ({ api_key: 'temp-secret-key', expires_at: '2026-09-17T10:00:00.000Z' }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await sonioxRealtimeProvider.mint('meeting-1');

    expect(token).toEqual({
      provider: 'soniox',
      token: 'temp-secret-key',
      wsUrl: 'wss://stt-rt.soniox.com/transcribe-websocket',
      expiresAt: '2026-09-17T10:00:00.000Z',
      model: env.sonioxRtModel,
      capabilities: { speakerLabels: true, translation: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const loggedText = logSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(loggedText).not.toContain('temp-secret-key');
    vi.unstubAllGlobals();
  });

  it('caps expires_in_seconds at 3600 even when the env TTL is higher', async () => {
    env.sonioxTempKeyTtlSec = 7200;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.expires_in_seconds).toBe(3600);
      return { ok: true, json: async () => ({ api_key: 'k', expires_at: 'x' }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await sonioxRealtimeProvider.mint('meeting-2');
    vi.unstubAllGlobals();
  });

  it('throws when Soniox rejects the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401 }) as Response),
    );
    await expect(sonioxRealtimeProvider.mint('meeting-1')).rejects.toThrow(/401/);
    vi.unstubAllGlobals();
  });
});
