import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));
// Concurrent-recording count enumerates the node-local known-rooms store, not app_settings.
vi.mock('../jobs/known-rooms-store.js', () => ({ readKnownRooms: async () => ['room-1'] }));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

function freshStore(): Store {
  return {
    meetings: [
      {
        _id: 'meeting-1',
        roomId: 'room-1',
        ownerUserId: 'user-1',
        status: 'recording',
        lastPartAt: new Date().toISOString(),
      },
    ],
  };
}

function context(userId: string): ToolCallContext {
  return {
    transport: 'direct',
    identityState: 'verified',
    sessionScope: 'test',
    actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' },
  };
}

const { env } = await import('../env.js');
const { resetRateLimits } = await import('./rate-limiter.js');
const { realtimeTokenTool } = await import('./realtime-token-tool.js');

describe('meeting_realtime_token', () => {
  const originalSonioxKey = env.sonioxApiKey;
  const originalCap = env.liveMaxConcurrentRecordings;

  beforeEach(() => {
    store = freshStore();
    fakeHub = installFakeHub({ store });
    resetRateLimits();
    env.sonioxApiKey = 'test-key';
    env.liveMaxConcurrentRecordings = 8;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ api_key: 'k', expires_at: 'x' }) }) as Response),
    );
  });

  afterEach(() => {
    env.sonioxApiKey = originalSonioxKey;
    env.liveMaxConcurrentRecordings = originalCap;
    vi.unstubAllGlobals();
  });

  it('rejects a caller who is not the meeting owner', async () => {
    await expect(
      realtimeTokenTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never),
    ).rejects.toThrow(/meeting owner/);
  });

  it('rejects a roomId that does not match the verified actor room', async () => {
    await expect(
      realtimeTokenTool.execute({ roomId: 'room-other', meetingId: 'meeting-1' }, context('user-1'), {} as never),
    ).rejects.toThrow(/Invalid request/);
  });

  it('rejects once the per-(user,meeting) budget is exceeded', async () => {
    for (let i = 0; i < 30; i++) {
      await realtimeTokenTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), {} as never);
    }
    await expect(
      realtimeTokenTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), {} as never),
    ).rejects.toThrow(/Exceeded the allowed number/);
  });

  it('rejects with a capacity message once LIVE_MAX_CONCURRENT_RECORDINGS is reached', async () => {
    env.liveMaxConcurrentRecordings = 1;
    await expect(
      realtimeTokenTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), {} as never),
    ).rejects.toThrow(/maximum of 1 meetings/);
  });

  it('names the missing env key when the selected provider has no key configured', async () => {
    env.sonioxApiKey = undefined;
    await expect(
      realtimeTokenTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), {} as never),
    ).rejects.toThrow(/SONIOX_API_KEY/);
  });

  it('mints a token for the owner when everything checks out', async () => {
    const result = (await realtimeTokenTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1' },
      context('user-1'),
      {} as never,
    )) as { provider: string; capabilities: { speakerLabels: boolean } };
    expect(result.provider).toBe('soniox');
    expect(result.capabilities.speakerLabels).toBe(true);
  });
});
