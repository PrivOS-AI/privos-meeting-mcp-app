import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext, RoomBoundHubClient } from '@privos_ai/app-server';

import type { ToolRuntime } from './registry.js';

const summarizeTranscript = vi.fn();
vi.mock('../summary/summarizer.js', () => ({ summarizeTranscript: (...args: unknown[]) => summarizeTranscript(...args) }));

let meetingRow: Record<string, unknown> | null;
vi.mock('../hub/app-db-bot-client.js', () => ({
  AppDbBotClient: vi.fn().mockImplementation(() => ({ getById: vi.fn(async () => meetingRow) })),
}));

const { resetRateLimits } = await import('./rate-limiter.js');
const { liveSummaryTool } = await import('./live-summary-tool.js');

function context(): ToolCallContext {
  return {
    transport: 'direct',
    identityState: 'verified',
    sessionScope: 'test',
    actor: { userId: 'user-1', roomId: 'room-1', claims: {}, provenance: 'user-token' },
  } as ToolCallContext;
}

function runtime(): ToolRuntime {
  return { agentBotHub: {} as RoomBoundHubClient };
}

const SEGMENTS = [
  { speakerId: 's0:1', speakerName: 'Alice', startSec: 0, text: 'We should ship on Friday.' },
  { speakerId: 's0:2', speakerName: 'Bob', startSec: 12, text: 'I will prepare the release notes.' },
  { speakerId: 's0:1', speakerName: 'Alice', startSec: 25, text: 'Great, thanks Bob.' },
];

describe('meeting_live_summary', () => {
  beforeEach(() => {
    resetRateLimits();
    summarizeTranscript.mockReset();
    summarizeTranscript.mockResolvedValue({
      summary: 'The team agreed to ship on Friday.',
      decisions: ['Ship on Friday'],
      action_items: [{ task: 'Prepare release notes', owner: 'Bob', due: null, at: 12 }],
      key_topics: ['release'],
    });
    meetingRow = { _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'user-1', status: 'recording' };
  });

  it('builds chunks from the caption lines and returns the summarizer payload', async () => {
    const result = (await liveSummaryTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', title: 'Weekly sync', language: 'en', segments: SEGMENTS },
      context(),
      runtime(),
    )) as { summary: string; action_items: unknown[] };

    expect(result.summary).toContain('Friday');
    expect(result.action_items).toHaveLength(1);

    expect(summarizeTranscript).toHaveBeenCalledTimes(1);
    const input = summarizeTranscript.mock.calls[0][1] as {
      chunks: unknown[];
      language: string;
      title: string;
      speakerNames: string[];
    };
    expect(input.chunks.length).toBeGreaterThan(0);
    expect(input.language).toBe('en');
    expect(input.title).toBe('Weekly sync');
    expect(input.speakerNames).toEqual(expect.arrayContaining(['Alice', 'Bob']));
  });

  it('rejects a call whose actor is not in the room', async () => {
    const ctx = context();
    (ctx.actor as { roomId: string }).roomId = 'other-room';
    await expect(liveSummaryTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', segments: SEGMENTS }, ctx, runtime())).rejects.toThrow();
    expect(summarizeTranscript).not.toHaveBeenCalled();
  });

  it('rejects when there are no caption lines', async () => {
    await expect(liveSummaryTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', segments: [] }, context(), runtime())).rejects.toThrow();
    expect(summarizeTranscript).not.toHaveBeenCalled();
  });

  it('rejects when the meeting is not in the room', async () => {
    meetingRow = null;
    await expect(liveSummaryTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', segments: SEGMENTS }, context(), runtime())).rejects.toThrow();
    expect(summarizeTranscript).not.toHaveBeenCalled();
  });

  it('rate-limits repeated calls for the same meeting', async () => {
    for (let i = 0; i < 6; i++) {
      await liveSummaryTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', segments: SEGMENTS }, context(), runtime());
    }
    await expect(liveSummaryTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', segments: SEGMENTS }, context(), runtime())).rejects.toThrow();
  });
});
