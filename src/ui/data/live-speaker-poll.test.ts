import { describe, expect, it, vi } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import { LiveSpeakerPoll } from './live-speaker-poll.js';

function fakeApp(callServerTool: McpApp['callServerTool']): McpApp {
  return { callServerTool } as unknown as McpApp;
}

describe('LiveSpeakerPoll', () => {
  it('builds a speakerKey -> LiveSpeaker map from sonioxLabels', async () => {
    const updates: Array<Map<string, unknown>> = [];
    const poll = new LiveSpeakerPoll(
      fakeApp(async () => ({
        sessionSpeakers: [
          { sessionSpeakerId: 'a', sonioxLabels: ['s0:1', 's0:1@2'], colorKey: 'blue', resolved: true, displayName: 'An', liveSpeechSec: 12 },
        ],
        labelsSupported: true,
        updatedAt: new Date().toISOString(),
      })),
      { roomId: 'r', meetingId: 'm', onUpdate: (map) => updates.push(map) },
    );

    await poll.pollOnce();
    poll.stop();

    expect(updates).toHaveLength(1);
    expect(updates[0].get('s0:1')).toMatchObject({ displayName: 'An' });
  });

  it('skips a merged-away (mergedInto) session speaker when building the label map — the winner already carries its labels', async () => {
    const updates: Array<Map<string, unknown>> = [];
    const poll = new LiveSpeakerPoll(
      fakeApp(async () => ({
        sessionSpeakers: [
          { sessionSpeakerId: 'winner', sonioxLabels: ['s0:1', 's0:2'], colorKey: 'blue', resolved: true, displayName: 'An', liveSpeechSec: 20 },
          { sessionSpeakerId: 'loser', sonioxLabels: ['s0:2'], colorKey: 'gold', resolved: false, liveSpeechSec: 5, mergedInto: 'winner' },
        ],
      })),
      { roomId: 'r', meetingId: 'm', onUpdate: (map) => updates.push(map) },
    );

    await poll.pollOnce();
    poll.stop();

    expect(updates[0].get('s0:2')).toMatchObject({ sessionSpeakerId: 'winner' });
  });

  it('forwards the raw speaker list and degraded/labelsSupported flags via onSpeakersUpdate', async () => {
    const onSpeakersUpdate = vi.fn();
    const poll = new LiveSpeakerPoll(
      fakeApp(async () => ({
        sessionSpeakers: [{ sessionSpeakerId: 'a', sonioxLabels: ['s0:1'], colorKey: 'blue', resolved: false, liveSpeechSec: 3 }],
        degraded: true,
        labelsSupported: true,
      })),
      { roomId: 'r', meetingId: 'm', onUpdate: () => {}, onSpeakersUpdate },
    );

    await poll.pollOnce();
    poll.stop();

    expect(onSpeakersUpdate).toHaveBeenCalledTimes(1);
    const [speakers, meta] = onSpeakersUpdate.mock.calls[0];
    expect(speakers).toHaveLength(1);
    expect(meta).toEqual({ degraded: true, labelsSupported: true });
  });

  it('swallows a failure (e.g. the P5 tool not existing yet) without throwing', async () => {
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
        return { sessionSpeakers: [] };
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
