import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomBoundHubClient } from '@privos_ai/app-server';

const generateAsyncWithHubAi = vi.fn();
vi.mock('../hub/hub-ai-client.js', () => ({
  generateAsyncWithHubAi: (...args: unknown[]) => generateAsyncWithHubAi(...args),
  PROMPT_LIMIT: 50_000,
  SYSTEM_LIMIT: 200_000,
}));

const { summarizeTranscript } = await import('./summarizer.js');
const { chunkTranscript } = await import('./chunker.js');
import type { Segment } from '../transcript/segment-builder.js';

const hub = {} as RoomBoundHubClient;

function segments(): Segment[] {
  return [
    { id: 's1', speakerId: 'spk1', startSec: 0, endSec: 5, text: 'Chào mọi người, hôm nay ta bàn kế hoạch.', lang: 'vi', tokenCount: 8 },
    { id: 's2', speakerId: 'spk2', startSec: 5, endSec: 10, text: 'Đồng ý, mình sẽ viết tài liệu trước thứ Sáu.', lang: 'vi', tokenCount: 9 },
  ];
}

function chunks() {
  return chunkTranscript(segments(), { spk1: 'Thanh', spk2: 'Nhân' });
}

describe('summarizeTranscript', () => {
  beforeEach(() => {
    generateAsyncWithHubAi.mockReset();
  });

  it('runs map then reduce and returns a validated payload with owners resolved', async () => {
    generateAsyncWithHubAi
      .mockResolvedValueOnce({ text: JSON.stringify({ notes: 'Bàn kế hoạch quý 3', decisions: [], action_items: [{ task: 'Viết tài liệu', owner: 'Thanh', due: null, at: 5 }] }) })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          summary: 'Nhóm đã bàn kế hoạch quý 3.',
          decisions: ['Ra mắt thứ Sáu'],
          action_items: [{ task: 'Viết tài liệu', owner: 'Thanh', due: null, at: 5 }],
          key_topics: ['kế hoạch quý 3'],
        }),
      });

    const result = await summarizeTranscript(hub, { roomId: 'room-1', chunks: chunks(), language: 'vi', title: 'Họp quý 3', speakerNames: ['Thanh', 'Nhân'] });

    expect(generateAsyncWithHubAi).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe('Nhóm đã bàn kế hoạch quý 3.');
    expect(result.decisions).toEqual(['Ra mắt thứ Sáu']);
    expect(result.action_items).toEqual([{ task: 'Viết tài liệu', owner: 'Thanh', due: null, at: 5 }]);
    expect(result.key_topics).toEqual(['kế hoạch quý 3']);
  });

  it('retries once with a schema-fix prompt when the JSON fails zod validation, then succeeds', async () => {
    generateAsyncWithHubAi
      .mockResolvedValueOnce({ text: JSON.stringify({ notes: 'ok', decisions: [], action_items: [] }) }) // map ok
      .mockResolvedValueOnce({ text: 'not json at all, sorry' }) // reduce: invalid
      .mockResolvedValueOnce({
        text: JSON.stringify({ summary: 'Tóm tắt sau khi sửa.', decisions: [], action_items: [], key_topics: [] }),
      }); // reduce: fixed

    const result = await summarizeTranscript(hub, { roomId: 'room-1', chunks: chunks(), language: 'vi', title: 'T', speakerNames: [] });
    expect(generateAsyncWithHubAi).toHaveBeenCalledTimes(3);
    expect(result.summary).toBe('Tóm tắt sau khi sửa.');
  });

  it('throws when the schema is still invalid after the one fix retry', async () => {
    generateAsyncWithHubAi
      .mockResolvedValueOnce({ text: JSON.stringify({ notes: 'ok', decisions: [], action_items: [] }) })
      .mockResolvedValueOnce({ text: 'garbage' })
      .mockResolvedValueOnce({ text: 'still garbage' });

    await expect(
      summarizeTranscript(hub, { roomId: 'room-1', chunks: chunks(), language: 'vi', title: 'T', speakerNames: [] }),
    ).rejects.toThrow(/schema/);
  });

  it('nulls out an action item owner that matches no known speaker and is unreasonably long', async () => {
    const longOwner = 'x'.repeat(90);
    generateAsyncWithHubAi
      .mockResolvedValueOnce({ text: JSON.stringify({ notes: 'ok', decisions: [], action_items: [] }) })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          summary: 's',
          decisions: [],
          action_items: [
            { task: 'a', owner: longOwner, due: null, at: null },
            { task: 'b', owner: 'Free text owner', due: null, at: null },
            { task: 'c', owner: 'Thanh', due: null, at: null },
          ],
          key_topics: [],
        }),
      });

    const result = await summarizeTranscript(hub, { roomId: 'room-1', chunks: chunks(), language: 'vi', title: 'T', speakerNames: ['Thanh'] });
    expect(result.action_items[0].owner).toBeNull(); // unmatched + >80 chars
    expect(result.action_items[1].owner).toBe('Free text owner'); // unmatched but <=80 chars, kept as free text
    expect(result.action_items[2].owner).toBe('Thanh'); // matches a known speaker
  });

  it('rejects when there are no chunks to summarize', async () => {
    await expect(
      summarizeTranscript(hub, { roomId: 'room-1', chunks: [], language: 'vi', title: 'T', speakerNames: [] }),
    ).rejects.toThrow(/transcript/);
  });
});
