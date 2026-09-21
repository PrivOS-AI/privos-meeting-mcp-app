import { describe, expect, it, vi } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { LiveSpeakerPoll } from './live-speaker-poll.js';

function fakeApp(callServerTool: McpApp['callServerTool']): McpApp {
  return { callServerTool } as unknown as McpApp;
}

describe('LiveSpeakerPoll', () => {
  // Phase 8 intentionally drops the `split('@')[0]` label-collapsing map this
  // poll used to build (`toSpeakerKeyMap`, root cause C7: a recycled label
  // silently overwrote its instances) — `onUpdate` now hands the caller the
  // raw `speakers` + `turns` lists straight from the tool response instead.
  it('forwards the raw speaker list and turns list unmodified', async () => {
    const onUpdate = vi.fn();
    const poll = new LiveSpeakerPoll(
      fakeApp(async () => ({
        sessionSpeakers: [
          { sessionSpeakerId: 'a', sonioxLabels: ['s0:1', 's0:1@2'], colorKey: 'blue', resolved: true, displayName: 'An', liveSpeechSec: 12 },
        ],
        turns: [{ startMs: 0, endMs: 3000, label: 's0:1', sessionSpeakerId: 'a' }],
        nextSinceMs: 3000,
        labelsSupported: true,
        updatedAt: new Date().toISOString(),
      })),
      { roomId: 'r', meetingId: 'm', onUpdate },
    );

    await poll.pollOnce();
    poll.stop();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const [speakers, turns, meta] = onUpdate.mock.calls[0];
    expect(speakers).toEqual([
      { sessionSpeakerId: 'a', sonioxLabels: ['s0:1', 's0:1@2'], colorKey: 'blue', resolved: true, displayName: 'An', liveSpeechSec: 12 },
    ]);
    expect(turns).toEqual([{ startMs: 0, endMs: 3000, label: 's0:1', sessionSpeakerId: 'a' }]);
    expect(meta).toEqual({ degraded: false, labelsSupported: true });
  });

  it('adopts nextSinceMs as the cursor for the following poll, and keeps it when a later poll returns nothing new', async () => {
    const calls: unknown[] = [];
    let response = { sessionSpeakers: [], turns: [{ startMs: 0, endMs: 1000, label: 's0:1', sessionSpeakerId: 'a' }], nextSinceMs: 1000 };
    const poll = new LiveSpeakerPoll(
      fakeApp(async (params) => {
        calls.push((params.arguments as Record<string, unknown>).sinceMs);
        return response;
      }),
      { roomId: 'r', meetingId: 'm', onUpdate: () => {} },
    );

    await poll.pollOnce(); // first call: no cursor yet
    response = { sessionSpeakers: [], turns: [], nextSinceMs: -1 } as never; // server: nothing new, no real cursor to give back
    await poll.pollOnce();
    poll.stop();

    expect(calls[0]).toBeUndefined(); // sinceMs omitted on the very first poll
    expect(calls[1]).toBe(1000); // adopted from the first response's nextSinceMs
  });

  it('never sends a negative sinceMs even if the server ever echoed one back', async () => {
    const calls: unknown[] = [];
    const poll = new LiveSpeakerPoll(
      fakeApp(async (params) => {
        calls.push((params.arguments as Record<string, unknown>).sinceMs);
        return { sessionSpeakers: [], turns: [], nextSinceMs: -1 };
      }),
      { roomId: 'r', meetingId: 'm', onUpdate: () => {} },
    );

    await poll.pollOnce();
    await poll.pollOnce();
    poll.stop();

    expect(calls).toEqual([undefined, undefined]);
  });

  it('swallows a failure (e.g. the tool not existing yet) without throwing', async () => {
    const onUpdate = vi.fn();
    const poll = new LiveSpeakerPoll(
      fakeApp(async () => {
        throw new Error('Unknown tool: meeting_live_speakers');
      }),
      { roomId: 'r', meetingId: 'm', onUpdate },
    );

    await expect(poll.pollOnce()).resolves.toBeUndefined();
    expect(onUpdate).not.toHaveBeenCalled();
    poll.stop();
  });

  it('stops polling once stop() is called', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const poll = new LiveSpeakerPoll(
      fakeApp(async () => {
        calls += 1;
        return { sessionSpeakers: [], turns: [] };
      }),
      { roomId: 'r', meetingId: 'm', intervalMs: 1000, onUpdate: () => {} },
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    poll.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    vi.useRealTimers();
  });
});
