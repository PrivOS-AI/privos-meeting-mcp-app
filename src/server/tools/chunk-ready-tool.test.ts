import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

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

const { chunkReadyTool } = await import('./chunk-ready-tool.js');

describe('meeting_chunk_ready', () => {
  beforeEach(() => {
    store = {
      meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'user-1', status: 'recording' }],
    };
    fakeHub = installFakeHub({ store });
  });

  const baseArgs = { roomId: 'room-1', meetingId: 'meeting-1', seq: 0, durationMs: 60_000 };

  it('accepts a valid chunk from the owner, including a not-yet-final trailing turn', async () => {
    const result = await chunkReadyTool.execute(
      {
        ...baseArgs,
        segments: [
          { speaker: 's0:1', startMs: 0, endMs: 20_000, final: true },
          { speaker: 's0:2', startMs: 20_000, endMs: 59_500, final: false },
        ],
      },
      context('user-1'),
      {} as never,
    );
    expect(result).toEqual({ accepted: true });
  });

  it('rejects a caller who is not the meeting owner', async () => {
    await expect(
      chunkReadyTool.execute({ ...baseArgs, segments: [] }, context('user-2'), {} as never),
    ).rejects.toThrow(/chủ cuộc họp/);
  });

  it('rejects a turn that runs past the declared part duration', async () => {
    await expect(
      chunkReadyTool.execute(
        { ...baseArgs, segments: [{ speaker: 's0:1', startMs: 0, endMs: 70_000, final: true }] },
        context('user-1'),
        {} as never,
      ),
    ).rejects.toThrow(/biên phần ghi âm/);
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
        {} as never,
      ),
    ).rejects.toThrow(/chồng lấn/);
  });

  it('rejects when the meeting is no longer recording or uploading', async () => {
    store.meetings[0].status = 'summarized';
    await expect(
      chunkReadyTool.execute({ ...baseArgs, segments: [] }, context('user-1'), {} as never),
    ).rejects.toThrow(/không ở trạng thái/);
  });
});
