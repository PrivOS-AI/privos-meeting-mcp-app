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

const aiReplies: string[] = [];
const prompts: string[] = [];
vi.mock('../hub/hub-ai-client.js', () => ({
  generateAsyncWithHubAi: async (_hub: unknown, input: { prompt: string }) => {
    prompts.push(input.prompt);
    return { text: aiReplies.shift() ?? '' };
  },
}));
vi.mock('../transcript/stored-transcript.js', () => ({
  loadStoredTranscript: async () => ({
    doc: {
      segments: [
        { id: 's1', speakerId: 'spk0', startSec: 10, endSec: 14, text: 'Quỳnh gửi báo giá cho khách trước thứ Năm nhé.' },
        { id: 's2', speakerId: 'spk1', startSec: 15, endSec: 17, text: 'Dạ, em gửi trước thứ Năm.' },
      ],
    },
    displayNameBySpeaker: { spk0: 'Ngân', spk1: 'Quỳnh' },
  }),
}));
let qaFile: string | null = null;
const uploads: Array<{ fileName: string; text: string }> = [];
vi.mock('../media/hub-file-download.js', () => ({
  listRoomFolderFiles: async () => (qaFile === null ? [] : [{ _id: 'qa-1', name: 'qa.md', channel_id: 'room-1', folder_id: 'folder-1' }]),
  fetchFileReadable: async () => Readable.from([qaFile ?? '']),
}));
vi.mock('../files/hub-file-upload.js', () => ({
  uploadBotFile: async (input: { fileName: string; data: Buffer }) => {
    const text = input.data.toString('utf8');
    uploads.push({ fileName: input.fileName, text });
    if (input.fileName === 'qa.md') qaFile = text;
    return { fileId: `${input.fileName}-id` };
  },
}));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { askTool, saveAnswerTool } = await import('./ask-tool.js');
const { notesTool } = await import('./notes-tool.js');
const { resetRateLimits } = await import('./rate-limiter.js');

function ctx(userId = 'u-ngan', roomId = 'room-1'): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId, claims: {}, provenance: 'user-token' } };
}

describe('meeting_ask / meeting_save_answer', () => {
  beforeEach(() => {
    resetRateLimits();
    aiReplies.length = 0;
    prompts.length = 0;
    uploads.length = 0;
    qaFile = null;
    store = { meetings: [{ _id: 'm1', roomId: 'room-1', ownerUserId: 'u-ngan', title: 'Họp tuần', folderId: 'folder-1', transcriptJsonFileId: 'tj-1', status: 'summarized' }] };
    fakeHub = installFakeHub({ store });
  });

  it('answers from the stored transcript with citations to real lines and a save token', async () => {
    aiReplies.push('{"answer":"Quỳnh gửi báo giá trước thứ Năm.","citations":["L1","L2","L7"],"insufficient":false}');
    const result = (await askTool.execute({ roomId: 'room-1', meetingId: 'm1', question: 'Ai gửi báo giá?' }, ctx(), {} as never)) as Record<string, unknown>;
    expect(result.answer).toBe('Quỳnh gửi báo giá trước thứ Năm.');
    expect(result.citations).toEqual([
      { lineId: 'L1', atSec: 10, speaker: 'Ngân', quote: 'Quỳnh gửi báo giá cho khách trước thứ Năm nhé.' },
      { lineId: 'L2', atSec: 15, speaker: 'Quỳnh', quote: 'Dạ, em gửi trước thứ Năm.' },
    ]);
    expect(typeof result.saveToken).toBe('string');
    // The transcript went to Hub AI fenced as data, with the speaker names.
    expect(prompts[0]).toContain('```untrusted');
    expect(prompts[0]).toContain('L1 [00:00:10] Ngân: Quỳnh gửi báo giá');
  });

  it('answers during the meeting from the caption lines the client sends', async () => {
    aiReplies.push('{"answer":"Chưa ai nhắc tới.","citations":[],"insufficient":true}');
    const result = (await askTool.execute(
      { roomId: 'room-1', meetingId: 'm1', question: 'Ngân sách?', segments: [{ speakerName: 'Ngân', startSec: 3, text: 'Bắt đầu nhé.' }] },
      ctx(),
      {} as never,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ insufficient: true, citations: [] });
    expect(prompts[0]).toContain('still in progress');
  });

  it('refuses another room', async () => {
    await expect(askTool.execute({ roomId: 'room-1', meetingId: 'm1', question: 'x' }, ctx('u-ngan', 'room-2'), {} as never)).rejects.toMatchObject({ code: 'ROOM_MISMATCH' });
  });

  it('saves the exact answer once to qa.md, and refuses an edited one', async () => {
    aiReplies.push('{"answer":"Quỳnh gửi báo giá trước thứ Năm.","citations":["L2"],"insufficient":false}');
    const asked = (await askTool.execute({ roomId: 'room-1', meetingId: 'm1', question: 'Ai gửi báo giá?' }, ctx(), {} as never)) as Record<string, unknown>;
    const { saveToken, ...answer } = asked;
    const save = (a: unknown, token = saveToken) => saveAnswerTool.execute({ roomId: 'room-1', meetingId: 'm1', question: 'Ai gửi báo giá?', answer: a, saveToken: token }, ctx(), {} as never);

    expect(await save(answer)).toMatchObject({ saved: true, fileName: 'qa.md' });
    expect(qaFile).toContain('# Q&A — Họp tuần');
    expect(qaFile).toContain('## Ai gửi báo giá?');
    expect(qaFile).toContain('- [00:00:15] Quỳnh: “Dạ, em gửi trước thứ Năm.”');

    expect(await save(answer)).toMatchObject({ saved: false, alreadySaved: true });
    expect(uploads.filter((u) => u.fileName === 'qa.md')).toHaveLength(1);

    await expect(save({ ...answer, answer: 'Ngân gửi.' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      saveAnswerTool.execute({ roomId: 'room-1', meetingId: 'm1', question: 'Ai gửi báo giá?', answer, saveToken }, ctx('u-other'), {} as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('meeting_notes_save', () => {
  beforeEach(() => {
    resetRateLimits();
    uploads.length = 0;
    store = { meetings: [{ _id: 'm1', roomId: 'room-1', ownerUserId: 'u-ngan', title: 'Họp tuần', folderId: 'folder-1', status: 'recording' }] };
    fakeHub = installFakeHub({ store });
  });

  it('stores the notes on the meeting and in notes.md, and never lets an older revision win', async () => {
    expect(await notesTool.execute({ roomId: 'room-1', meetingId: 'm1', text: 'Chốt thứ Sáu', revision: 2 }, ctx(), {} as never)).toMatchObject({ saved: true, fileSaved: true });
    expect(store.meetings[0]).toMatchObject({ notesText: 'Chốt thứ Sáu', notesRevision: 2 });
    expect(uploads.at(-1)).toEqual({ fileName: 'notes.md', text: '# Notes — Họp tuần\n\nChốt thứ Sáu\n' });

    expect(await notesTool.execute({ roomId: 'room-1', meetingId: 'm1', text: 'bản cũ', revision: 1 }, ctx(), {} as never)).toMatchObject({ saved: false, stale: true });
    expect(store.meetings[0].notesText).toBe('Chốt thứ Sáu');
  });

  it('is for the meeting owner only', async () => {
    await expect(notesTool.execute({ roomId: 'room-1', meetingId: 'm1', text: 'x', revision: 1 }, ctx('u-other'), {} as never)).rejects.toMatchObject({ code: 'NOT_MEETING_OWNER' });
  });
});
