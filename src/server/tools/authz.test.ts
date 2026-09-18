import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext, VerifiedActor } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));
vi.mock('../media/hub-file-download.js', () => ({ getFileMetadata: vi.fn() }));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { AppDbBotClient } = await import('../hub/app-db-bot-client.js');
const { getFileMetadata } = await import('../media/hub-file-download.js');
const { assertFileInRoom, requireMeetingOwner, requireVerifiedActor } = await import('./authz.js');

function actor(overrides: Partial<VerifiedActor> = {}): VerifiedActor {
  return { userId: 'user-1', roomId: 'room-1', claims: {}, provenance: 'user-token', ...overrides };
}

function ctx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: actor(), ...overrides };
}

describe('requireVerifiedActor', () => {
  it('rejects a missing actor', () => {
    expect(() => requireVerifiedActor(ctx({ actor: undefined }))).toThrow(/xác minh/);
  });

  it('rejects when identityState is not verified', () => {
    expect(() => requireVerifiedActor(ctx({ identityState: 'invalid' }))).toThrow(/xác minh/);
  });

  it('returns the actor when verified', () => {
    expect(requireVerifiedActor(ctx()).userId).toBe('user-1');
  });
});

describe('requireMeetingOwner', () => {
  beforeEach(() => {
    store = { meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'user-1' }] };
    fakeHub = installFakeHub({ store });
  });

  it('rejects when the actor room does not match roomId', async () => {
    const db = new AppDbBotClient('room-1');
    await expect(requireMeetingOwner(db, actor({ roomId: 'room-other' }), 'room-1', 'meeting-1')).rejects.toThrow(/không hợp lệ/);
  });

  it('rejects a meeting that does not exist', async () => {
    const db = new AppDbBotClient('room-1');
    await expect(requireMeetingOwner(db, actor(), 'room-1', 'missing')).rejects.toThrow(/Không tìm thấy/);
  });

  it('rejects a meeting belonging to a different room', async () => {
    store.meetings = [{ _id: 'meeting-2', roomId: 'room-2', ownerUserId: 'user-1' }];
    const db = new AppDbBotClient('room-1');
    await expect(requireMeetingOwner(db, actor(), 'room-1', 'meeting-2')).rejects.toThrow(/Không tìm thấy/);
  });

  it('rejects a caller who is not the meeting owner', async () => {
    const db = new AppDbBotClient('room-1');
    await expect(requireMeetingOwner(db, actor({ userId: 'user-2' }), 'room-1', 'meeting-1')).rejects.toThrow(/chủ cuộc họp/);
  });

  it('returns the meeting row for the owner', async () => {
    const db = new AppDbBotClient('room-1');
    const meeting = await requireMeetingOwner(db, actor(), 'room-1', 'meeting-1');
    expect(meeting._id).toBe('meeting-1');
  });
});

describe('assertFileInRoom', () => {
  afterEach(() => vi.mocked(getFileMetadata).mockReset());

  it('rejects a missing file', async () => {
    vi.mocked(getFileMetadata).mockResolvedValue(null);
    await expect(assertFileInRoom({} as never, 'f1', 'room-1')).rejects.toThrow(/Không tìm thấy/);
  });

  it('rejects a file that belongs to a different room', async () => {
    vi.mocked(getFileMetadata).mockResolvedValue({ _id: 'f1', name: 'x', channel_id: 'room-2', folder_id: null });
    await expect(assertFileInRoom({} as never, 'f1', 'room-1')).rejects.toThrow(/Không tìm thấy/);
  });

  it('returns the metadata for a file that belongs to the room', async () => {
    vi.mocked(getFileMetadata).mockResolvedValue({ _id: 'f1', name: 'x', channel_id: 'room-1', folder_id: null });
    const meta = await assertFileInRoom({} as never, 'f1', 'room-1');
    expect(meta.channel_id).toBe('room-1');
  });
});
