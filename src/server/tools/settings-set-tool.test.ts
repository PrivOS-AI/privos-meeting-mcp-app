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

function context(claims: Record<string, unknown> = {}): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId: 'user-1', roomId: 'room-1', claims, provenance: 'user-token' } };
}

const { settingsSetTool } = await import('./settings-set-tool.js');

describe('meeting_settings_set', () => {
  beforeEach(() => {
    store = { app_settings: [] };
    fakeHub = installFakeHub({ store });
  });

  it('lets any verified room member change the room settings (interim policy: the Hub exposes no role signal)', async () => {
    await settingsSetTool.execute({ key: 'speakerMatchThreshold', value: 0.5 }, context(), {} as never);
    expect(store.app_settings.map((r) => r.key)).toEqual(['room:room-1:speakerMatchThreshold']);
  });

  it('rejects a caller that is not bound to a room', async () => {
    const roomless = context();
    (roomless.actor as { roomId?: string }).roomId = undefined;
    await expect(settingsSetTool.execute({ key: 'speakerMatchThreshold', value: 0.5 }, roomless, {} as never)).rejects.toThrow(/thành viên của phòng/);
  });

  it('rejects an unsupported key even for an admin', async () => {
    await expect(settingsSetTool.execute({ key: 'notARealKey', value: 1 }, context({ isAdmin: true }), {} as never)).rejects.toThrow(/không được hỗ trợ/);
  });

  it('rejects an out-of-range threshold', async () => {
    await expect(
      settingsSetTool.execute({ key: 'speakerMatchThreshold', value: 1.5 }, context({ isAdmin: true }), {} as never),
    ).rejects.toThrow(/khoảng/);
  });

  it('lets an admin persist a valid setting into app_settings', async () => {
    const result = (await settingsSetTool.execute(
      { key: 'sttRealtimeProvider', value: 'elevenlabs' },
      context({ isAdmin: true }),
      {} as never,
    )) as { settings: Record<string, unknown> };
    expect(result.settings).toEqual({ sttRealtimeProvider: 'elevenlabs' });
    expect(store.app_settings).toHaveLength(1);
    expect(JSON.parse(String(store.app_settings[0].valueJson))).toBe('elevenlabs');
  });

  it('recognizes the roles[] admin claim shape too', async () => {
    const result = (await settingsSetTool.execute(
      { key: 'autoDeleteAudioDays', value: 30 },
      context({ roles: ['member', 'admin'] }),
      {} as never,
    )) as { settings: Record<string, unknown> };
    expect(result.settings).toEqual({ autoDeleteAudioDays: 30 });
  });
});
