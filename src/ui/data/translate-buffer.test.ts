import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { TranslateBuffer } from './translate-buffer.js';

function fakeApp(callServerTool: McpApp['callServerTool']): McpApp {
  return { callServerTool } as unknown as McpApp;
}

describe('TranslateBuffer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches pushed lines and flushes them together on a call to meeting_translate', async () => {
    const calls: Record<string, unknown>[] = [];
    const buffer = new TranslateBuffer(
      fakeApp(async (params) => {
        calls.push(params.arguments as Record<string, unknown>);
        return { translations: [{ id: 'l1', text: 'hi' }, { id: 'l2', text: 'bye' }] };
      }),
      { roomId: 'r', meetingId: 'm', target: 'en', onTranslated: () => {} },
    );

    buffer.push({ id: 'l1', text: 'xin chào', lang: 'vi' });
    buffer.push({ id: 'l2', text: 'tạm biệt', lang: 'vi' });
    await buffer.flush();

    expect(calls).toHaveLength(1);
    expect((calls[0].segments as unknown[]).length).toBe(2);
    buffer.dispose();
  });

  it('drops a line already in the target language without ever sending it', async () => {
    const calls: unknown[] = [];
    const buffer = new TranslateBuffer(fakeApp(async (p) => { calls.push(p); return { translations: [] }; }), {
      roomId: 'r',
      meetingId: 'm',
      target: 'en',
      onTranslated: () => {},
    });

    buffer.push({ id: 'l1', text: 'hello', lang: 'en' });
    await buffer.flush();

    expect(calls).toHaveLength(0);
    buffer.dispose();
  });

  it('drops a failed/timed-out batch without throwing and without blocking future flushes', async () => {
    let attempt = 0;
    const onError = vi.fn();
    const onTranslated = vi.fn();
    const buffer = new TranslateBuffer(
      fakeApp(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('timeout');
        return { translations: [{ id: 'l2', text: 'ok' }] };
      }),
      { roomId: 'r', meetingId: 'm', target: 'en', onTranslated, onError },
    );

    buffer.push({ id: 'l1', text: 'a', lang: 'vi' });
    await buffer.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onTranslated).not.toHaveBeenCalled();

    buffer.push({ id: 'l2', text: 'b', lang: 'vi' });
    await buffer.flush();
    expect(onTranslated).toHaveBeenCalledWith([{ id: 'l2', text: 'ok' }]);
    buffer.dispose();
  });

  it('flushes automatically on the configured interval', async () => {
    vi.useFakeTimers();
    const onTranslated = vi.fn();
    const buffer = new TranslateBuffer(fakeApp(async () => ({ translations: [{ id: 'l1', text: 'hi' }] })), {
      roomId: 'r',
      meetingId: 'm',
      target: 'en',
      flushIntervalMs: 4000,
      onTranslated,
    });

    buffer.push({ id: 'l1', text: 'xin chào', lang: 'vi' });
    await vi.advanceTimersByTimeAsync(4000);

    expect(onTranslated).toHaveBeenCalledWith([{ id: 'l1', text: 'hi' }]);
    buffer.dispose();
  });

  it('setEnabled(false) drops queued lines and stops accepting new ones', async () => {
    const onTranslated = vi.fn();
    const buffer = new TranslateBuffer(fakeApp(async () => ({ translations: [] })), {
      roomId: 'r',
      meetingId: 'm',
      target: 'en',
      onTranslated,
    });

    buffer.push({ id: 'l1', text: 'xin chào', lang: 'vi' });
    buffer.setEnabled(false);
    buffer.push({ id: 'l2', text: 'tạm biệt', lang: 'vi' });
    await buffer.flush();

    expect(onTranslated).not.toHaveBeenCalled();
    buffer.dispose();
  });
});
