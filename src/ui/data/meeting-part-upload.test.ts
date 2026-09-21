import { describe, expect, it, vi } from 'vitest';
import type { McpApp, UploadFileParams } from '@privos_ai/app-react';

import { listParts, notifyChunkReady, uploadPart } from './meeting-part-upload.js';

function fakeApp(overrides: Partial<McpApp> = {}): McpApp {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    callServerTool: vi.fn(),
    rest: vi.fn(),
    uploadFile: vi.fn(),
    storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    registerChatSurface: vi.fn(),
    setChatOpen: vi.fn(),
    requestProviderEmbed: vi.fn(),
    setProviderEmbedRect: vi.fn(),
    teardownProviderEmbed: vi.fn(),
    ...overrides,
  } as unknown as McpApp;
}

describe('uploadPart', () => {
  it('names the part with the meetingId8 suffix and NEVER sends duplicateAction:"replace"', async () => {
    let seen: UploadFileParams | undefined;
    const app = fakeApp({
      uploadFile: vi.fn(async (params: UploadFileParams) => {
        seen = params;
        return { file: { _id: 'file-1' } };
      }),
    });

    const blob = new Blob(['abc'], { type: 'audio/webm' });
    const result = await uploadPart(app, { roomId: 'room-1', folderId: 'folder-1', meetingId: 'meeting1234567890', seq: 3, blob });

    expect(result).toEqual({ fileId: 'file-1' });
    expect(seen?.fileName).toBe('audio.part-0003-meeting1.webm');
    expect(seen?.duplicateAction).toBe('keep_both');
    expect(seen?.duplicateAction).not.toBe('replace');
    expect(seen?.channelId).toBe('room-1');
    expect(seen?.folderId).toBe('folder-1');
  });

  it('throws when the Hub response carries no file id', async () => {
    const app = fakeApp({ uploadFile: vi.fn(async () => ({})) });
    await expect(
      uploadPart(app, { roomId: 'r', folderId: 'f', meetingId: 'm', seq: 0, blob: new Blob(['x']) }),
    ).rejects.toThrow(/id/);
  });
});

describe('listParts', () => {
  it('returns only audio.part- files, sorted by name (seq order)', async () => {
    const app = fakeApp({
      rest: vi.fn(async () => ({
        statusCode: 200,
        body: {
          files: [
            { _id: 'b', name: 'audio.part-0002-abcd1234.webm' },
            { _id: 'x', name: 'notes.txt' },
            { _id: 'a', name: 'audio.part-0001-abcd1234.webm' },
          ],
        },
      })),
    });

    const parts = await listParts(app, 'room-1', 'folder-1');
    expect(parts.map((p) => p.name)).toEqual(['audio.part-0001-abcd1234.webm', 'audio.part-0002-abcd1234.webm']);
  });
});

describe('notifyChunkReady', () => {
  it('calls meeting_chunk_ready with the given arguments', async () => {
    const app = fakeApp({ callServerTool: vi.fn(async () => ({})) });
    await notifyChunkReady(app, { roomId: 'r', meetingId: 'm', seq: 0, durationMs: 1000, partStartMs: 0, segments: [] });
    expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'meeting_chunk_ready',
      arguments: { roomId: 'r', meetingId: 'm', seq: 0, durationMs: 1000, partStartMs: 0, segments: [] },
    });
  });

  it('swallows a chunk_ready failure so it never blocks the next part', async () => {
    const app = fakeApp({ callServerTool: vi.fn(async () => Promise.reject(new Error('boom'))) });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(notifyChunkReady(app, { roomId: 'r', meetingId: 'm', seq: 0, durationMs: 1000, partStartMs: 0, segments: [] })).resolves.toBeUndefined();
    // A second call right after must still be attempted — nothing latches into a failed state.
    await expect(notifyChunkReady(app, { roomId: 'r', meetingId: 'm', seq: 1, durationMs: 1000, partStartMs: 60_000, segments: [] })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
