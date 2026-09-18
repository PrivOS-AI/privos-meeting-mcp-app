import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomBoundHubClient } from '@privos_ai/app-server';

const generateAsyncWithHubAi = vi.fn();
vi.mock('../hub/hub-ai-client.js', () => ({
  generateAsyncWithHubAi: (...args: unknown[]) => generateAsyncWithHubAi(...args),
  PROMPT_LIMIT: 50_000,
  SYSTEM_LIMIT: 200_000,
}));

const { translateSegmentsBatch } = await import('./translator.js');
import type { Segment } from '../transcript/segment-builder.js';

const hub = {} as RoomBoundHubClient;

function segment(overrides: Partial<Segment>): Segment {
  return { id: 'seg-0', speakerId: 'spk1', startSec: 0, endSec: 1, text: 'hello', lang: 'en', tokenCount: 1, ...overrides };
}

describe('translateSegmentsBatch', () => {
  beforeEach(() => {
    generateAsyncWithHubAi.mockReset();
  });

  it('translates only segments not already in the target language', async () => {
    generateAsyncWithHubAi.mockResolvedValueOnce({
      text: JSON.stringify([{ id: 's1', text: 'xin chào' }]),
    });

    const segments = [segment({ id: 's1', text: 'hello', lang: 'en' }), segment({ id: 's2', text: 'xin chào', lang: 'vi' })];
    const result = await translateSegmentsBatch(hub, { roomId: 'room-1', segments, target: 'vi' });

    expect(generateAsyncWithHubAi).toHaveBeenCalledTimes(1);
    expect(result.get('s1')).toBe('xin chào');
    expect(result.has('s2')).toBe(false); // already vi — skipped entirely
  });

  it('returns an empty map without calling Hub AI when nothing needs translation', async () => {
    const segments = [segment({ id: 's1', text: 'xin chào', lang: 'vi' })];
    const result = await translateSegmentsBatch(hub, { roomId: 'room-1', segments, target: 'vi' });
    expect(result.size).toBe(0);
    expect(generateAsyncWithHubAi).not.toHaveBeenCalled();
  });

  it('splits into multiple batches once the char budget is exceeded', async () => {
    generateAsyncWithHubAi
      .mockResolvedValueOnce({ text: JSON.stringify([{ id: 's1', text: 't1' }]) })
      .mockResolvedValueOnce({ text: JSON.stringify([{ id: 's2', text: 't2' }]) });

    const longText = 'x'.repeat(30_000);
    const segments = [segment({ id: 's1', text: longText, lang: 'en' }), segment({ id: 's2', text: longText, lang: 'en' })];
    const result = await translateSegmentsBatch(hub, { roomId: 'room-1', segments, target: 'vi' });

    expect(generateAsyncWithHubAi).toHaveBeenCalledTimes(2);
    expect(result.get('s1')).toBe('t1');
    expect(result.get('s2')).toBe('t2');
  });

  it('skips a batch that errors instead of failing the whole pass', async () => {
    generateAsyncWithHubAi
      .mockRejectedValueOnce(new Error('Hub AI unavailable'))
      .mockResolvedValueOnce({ text: JSON.stringify([{ id: 's2', text: 't2' }]) });

    const longText = 'x'.repeat(30_000);
    const segments = [segment({ id: 's1', text: longText, lang: 'en' }), segment({ id: 's2', text: longText, lang: 'en' })];
    const result = await translateSegmentsBatch(hub, { roomId: 'room-1', segments, target: 'vi' });

    expect(result.has('s1')).toBe(false); // failed batch skipped
    expect(result.get('s2')).toBe('t2'); // second batch still succeeds
  });
});
