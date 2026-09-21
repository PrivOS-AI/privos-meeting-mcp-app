import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../env.js';
import { elevenLabsRealtimeProvider } from './elevenlabs-realtime-token.js';

describe('elevenLabsRealtimeProvider.mint', () => {
  const originalKey = env.elevenLabsApiKey;

  beforeEach(() => {
    env.elevenLabsApiKey = 'test-elevenlabs-key';
  });

  afterEach(() => {
    env.elevenLabsApiKey = originalKey;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws a clear error when the vendor key is missing', async () => {
    env.elevenLabsApiKey = undefined;
    await expect(elevenLabsRealtimeProvider.mint('meeting-1')).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });

  it('POSTs to the single-use realtime_scribe endpoint with the xi-api-key header', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
      expect((init.headers as Record<string, string>)['xi-api-key']).toBe('test-elevenlabs-key');
      return { ok: true, json: async () => ({ token: 'temp-secret-token' }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await elevenLabsRealtimeProvider.mint('meeting-1');

    expect(token.provider).toBe('elevenlabs');
    expect(token.token).toBe('temp-secret-token');
    expect(token.capabilities).toEqual({ speakerLabels: false, translation: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never has the token appear in a thrown error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403 }) as Response),
    );
    await expect(elevenLabsRealtimeProvider.mint('meeting-1')).rejects.toThrow(/403/);
  });
});
