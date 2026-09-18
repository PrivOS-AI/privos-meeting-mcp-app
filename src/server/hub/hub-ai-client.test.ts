import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { generateAsyncWithHubAi, generateWithHubAi, PROMPT_LIMIT } from './hub-ai-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('generateWithHubAi', () => {
  it('rejects a prompt at/over PROMPT_LIMIT before ever calling the Hub', async () => {
    const authorizedFetch = vi.fn();
    const hub = { authorizedFetch } as unknown as RoomBoundHubClient;
    await expect(generateWithHubAi(hub, { roomId: 'r1', prompt: 'x'.repeat(PROMPT_LIMIT) })).rejects.toThrow(/vượt quá giới hạn/);
    expect(authorizedFetch).not.toHaveBeenCalled();
  });

  it('returns the Hub AI text on success', async () => {
    const authorizedFetch = vi.fn(async () => jsonResponse(200, { text: 'hello', source: 'room' }));
    const hub = { authorizedFetch } as unknown as RoomBoundHubClient;
    const result = await generateWithHubAi(hub, { roomId: 'r1', prompt: 'hi' });
    expect(result).toEqual({ text: 'hello', source: 'room' });
  });
});

describe('generateAsyncWithHubAi', () => {
  it('polls attempt-status (1s -> 2s -> 4s backoff) until a success state and returns its text', async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const authorizedFetch = vi.fn(async (path: string) => {
      if (path === '/api/v1/agents.sandbox.generate-async') return jsonResponse(200, { attemptId: 'attempt-1' });
      pollCount += 1;
      if (pollCount < 3) return jsonResponse(200, { status: 'processing' });
      return jsonResponse(200, { status: 'completed', text: 'the summary', source: 'room' });
    });
    const hub = { authorizedFetch } as unknown as RoomBoundHubClient;

    const resultPromise = generateAsyncWithHubAi(hub, { roomId: 'r1', prompt: 'summarize this' });
    await vi.advanceTimersByTimeAsync(1_000); // 1st poll -> processing
    await vi.advanceTimersByTimeAsync(2_000); // 2nd poll -> processing
    await vi.advanceTimersByTimeAsync(4_000); // 3rd poll -> completed

    await expect(resultPromise).resolves.toEqual({ text: 'the summary', source: 'room' });
    expect(pollCount).toBe(3);
  });

  it('throws with the Hub-reported reason on a failed attempt', async () => {
    vi.useFakeTimers();
    const authorizedFetch = vi.fn(async (path: string) => {
      if (path === '/api/v1/agents.sandbox.generate-async') return jsonResponse(200, { attemptId: 'attempt-2' });
      return jsonResponse(200, { status: 'failed', error: 'model overloaded' });
    });
    const hub = { authorizedFetch } as unknown as RoomBoundHubClient;

    const resultPromise = generateAsyncWithHubAi(hub, { roomId: 'r1', prompt: 'summarize this' });
    const assertion = expect(resultPromise).rejects.toThrow(/model overloaded/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('aborts promptly when the caller signal fires before the first poll', async () => {
    const controller = new AbortController();
    const authorizedFetch = vi.fn(async (path: string) => {
      if (path === '/api/v1/agents.sandbox.generate-async') return jsonResponse(200, { attemptId: 'attempt-3' });
      return jsonResponse(200, { status: 'processing' });
    });
    const hub = { authorizedFetch } as unknown as RoomBoundHubClient;

    const promise = generateAsyncWithHubAi(hub, { roomId: 'r1', prompt: 'summarize this' }, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/huỷ/);
  });

  it('rejects when generate-async never returns an attemptId', async () => {
    const authorizedFetch = vi.fn(async () => jsonResponse(200, {}));
    const hub = { authorizedFetch } as unknown as RoomBoundHubClient;
    await expect(generateAsyncWithHubAi(hub, { roomId: 'r1', prompt: 'x' })).rejects.toThrow(/attemptId/);
  });
});
