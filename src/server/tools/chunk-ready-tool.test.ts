import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

const enqueueChunk = vi.fn();
vi.mock('../live-speakers/chunk-worker.js', () => ({ enqueueChunk: (...args: unknown[]) => enqueueChunk(...args) }));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

function context(userId: string): ToolCallContext {
  return {
    transport: 'direct',
    identityState: 'verified',
    sessionScope: 'test',
    actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' },
  };
}

const runtime = { agentBotHub: {} as never };

const { chunkReadyTool } = await import('./chunk-ready-tool.js');

describe('meeting_chunk_ready', () => {
  beforeEach(() => {
    enqueueChunk.mockClear();
    store = {
      meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'user-1', status: 'recording', folderId: 'folder-1' }],
      app_settings: [],
    };
    fakeHub = installFakeHub({ store });
  });

  const baseArgs = { roomId: 'room-1', meetingId: 'meeting-1', seq: 0, durationMs: 60_000 };

  it('accepts a valid chunk from the owner and enqueues it, including a not-yet-final trailing turn', async () => {
    const result = await chunkReadyTool.execute(
      {
        ...baseArgs,
        segments: [
          { speaker: 's0:1', startMs: 0, endMs: 20_000, final: true },
          { speaker: 's0:2', startMs: 20_000, endMs: 59_500, final: false },
        ],
      },
      context('user-1'),
      runtime,
    );
    expect(result).toEqual({ accepted: true });
    expect(enqueueChunk).toHaveBeenCalledTimes(1);
    const [ctx, req] = enqueueChunk.mock.calls[0];
    expect(ctx.folderId).toBe('folder-1');
    expect(req).toMatchObject({ roomId: 'room-1', meetingId: 'meeting-1', seq: 0, durationMs: 60_000 });
    expect(req.segments).toHaveLength(2);
  });

  it('rejects a caller who is not the meeting owner, without enqueueing', async () => {
    await expect(chunkReadyTool.execute({ ...baseArgs, segments: [] }, context('user-2'), runtime)).rejects.toThrow(/chủ cuộc họp/);
    expect(enqueueChunk).not.toHaveBeenCalled();
  });

  it('does NOT reject a turn that crosses the part boundary — that is deferred by the worker, not the tool', async () => {
    const result = await chunkReadyTool.execute(
      { ...baseArgs, segments: [{ speaker: 's0:1', startMs: 58_000, endMs: 63_000, final: false }] },
      context('user-1'),
      runtime,
    );
    expect(result).toEqual({ accepted: true });
    expect(enqueueChunk).toHaveBeenCalledTimes(1);
  });

  it('rejects a total claimed duration far beyond the part (anti-abuse bound)', async () => {
    await expect(
      chunkReadyTool.execute({ ...baseArgs, segments: [{ speaker: 's0:1', startMs: 0, endMs: 300_000, final: true }] }, context('user-1'), runtime),
    ).rejects.toThrow(/vượt quá/);
    expect(enqueueChunk).not.toHaveBeenCalled();
  });

  it('rejects two overlapping turns for the same speaker', async () => {
    await expect(
      chunkReadyTool.execute(
        {
          ...baseArgs,
          segments: [
            { speaker: 's0:1', startMs: 0, endMs: 20_000, final: true },
            { speaker: 's0:1', startMs: 10_000, endMs: 30_000, final: true },
          ],
        },
        context('user-1'),
        runtime,
      ),
    ).rejects.toThrow(/chồng lấn/);
    expect(enqueueChunk).not.toHaveBeenCalled();
  });

  it('rejects when the meeting is no longer recording or uploading', async () => {
    store.meetings[0].status = 'summarized';
    await expect(chunkReadyTool.execute({ ...baseArgs, segments: [] }, context('user-1'), runtime)).rejects.toThrow(/không ở trạng thái/);
    expect(enqueueChunk).not.toHaveBeenCalled();
  });

  it('returns labels_not_supported (not an error) when the workspace realtime provider has no speaker labels', async () => {
    store.app_settings.push({ _id: 'row-settings-1', key: 'sttRealtimeProvider', valueJson: JSON.stringify('elevenlabs') });
    const result = await chunkReadyTool.execute({ ...baseArgs, segments: [] }, context('user-1'), runtime);
    expect(result).toEqual({ accepted: false, reason: 'labels_not_supported' });
    expect(enqueueChunk).not.toHaveBeenCalled();
  });
});
