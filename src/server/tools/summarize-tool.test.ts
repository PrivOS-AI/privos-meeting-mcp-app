import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

const summarizeTranscript = vi.fn();
vi.mock('../jobs/meeting-job.js', () => ({ summarizeTranscript: (...args: unknown[]) => summarizeTranscript(...args) }));

let transcriptDoc: Record<string, unknown>;
vi.mock('../media/hub-file-download.js', () => ({
  fetchFileReadable: async () => Readable.from([Buffer.from(JSON.stringify(transcriptDoc))]),
}));

const uploadCalls: { fileName: string }[] = [];
vi.mock('../files/hub-file-upload.js', () => ({
  uploadBotFile: async (input: { fileName: string }) => {
    uploadCalls.push({ fileName: input.fileName });
    return { fileId: `file-${input.fileName}` };
  },
}));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

function context(userId: string): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' } };
}

function runtime() {
  return { agentBotHub: fakeHub };
}

const { summarizeTool } = await import('./summarize-tool.js');

describe('meeting_summarize', () => {
  beforeEach(() => {
    summarizeTranscript.mockReset();
    uploadCalls.length = 0;
    transcriptDoc = {
      version: 2,
      meetingId: 'meeting-1',
      title: 'Họp tuần',
      startedAt: '2026-09-18T09:00:00.000Z',
      durationSec: 60,
      languageCode: 'vi',
      provider: 'soniox-async',
      speakers: [{ speakerId: 'spk1', totalSpeakSec: 30, displayName: 'Người nói 1' }],
      segments: [{ id: 's1', speakerId: 'spk1', startSec: 0, endSec: 5, text: 'xin chào', lang: 'vi', tokenCount: 2 }],
      tokens: [],
    };
    store = {
      meetings: [
        { _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'user-1', title: 'Họp tuần', transcriptJsonFileId: 'json-1', folderId: 'folder-1', durationSec: 60, language: 'vi' },
      ],
      meeting_speakers: [{ _id: 'sp-1', meeting: 'meeting-1', speakerId: 'spk1', displayName: 'Thanh' }],
    };
    fakeHub = installFakeHub({ store });
  });

  it('re-summarizes from transcript.json, rewrites transcript files, and updates the meeting row', async () => {
    summarizeTranscript.mockResolvedValueOnce({
      payload: { summary: 'Tóm tắt mới.', decisions: [], action_items: [], key_topics: ['a'] },
      summaryFileId: 'summary-file-1',
      translatedSegments: transcriptDoc.segments,
    });

    const result = (await summarizeTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), runtime())) as {
      summary: { summary: string };
    };

    expect(result.summary.summary).toBe('Tóm tắt mới.');
    expect(summarizeTranscript).toHaveBeenCalledTimes(1);
    const call = summarizeTranscript.mock.calls[0][0];
    // Uses the CURRENT meeting_speakers display name ("Thanh"), not the one frozen in transcript.json.
    expect(call.speakers[0].displayName).toBe('Thanh');

    expect(uploadCalls.map((c) => c.fileName).sort()).toEqual(['transcript.json', 'transcript.md', 'transcript.srt']);
    const updated = store.meetings.find((m) => m._id === 'meeting-1');
    expect(updated?.summaryFileId).toBe('summary-file-1');
    expect(updated?.summaryText).toBe('Tóm tắt mới.');
    expect(updated?.summaryError).toBe('');
  });

  it('records summaryError and rejects when Hub AI fails', async () => {
    summarizeTranscript.mockRejectedValueOnce(new Error('Hub AI trả lỗi: quota exceeded'));

    await expect(summarizeTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), runtime())).rejects.toThrow(/quota exceeded/);

    const updated = store.meetings.find((m) => m._id === 'meeting-1');
    expect(updated?.summaryError).toContain('quota exceeded');
    expect(uploadCalls).toHaveLength(0); // never rewrites transcript files on failure
  });

  it('rejects when the meeting has no transcript yet', async () => {
    store.meetings[0].transcriptJsonFileId = undefined;
    await expect(summarizeTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), runtime())).rejects.toThrow(/transcript/);
    expect(summarizeTranscript).not.toHaveBeenCalled();
  });

  it('rejects a caller who does not own the meeting', async () => {
    await expect(summarizeTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('someone-else'), runtime())).rejects.toThrow(/chủ cuộc họp/);
  });
});
