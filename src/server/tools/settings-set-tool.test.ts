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

/** Roles as the SDK lifts them from the Hub-signed `room_roles` / `workspace_roles` claims; omitted = no role signal. */
function context(roles: { roomRoles?: string[]; workspaceRoles?: string[] } = {}): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId: 'user-1', roomId: 'room-1', claims: {}, provenance: 'user-token', ...roles } };
}

const { settingsSetTool } = await import('./settings-set-tool.js');

describe('meeting_settings_set', () => {
  beforeEach(() => {
    store = { app_settings: [] };
    fakeHub = installFakeHub({ store });
  });

  it.each([
    ['a room owner', { roomRoles: ['owner'] }],
    ['a room moderator', { roomRoles: ['moderator'] }],
    ['a workspace admin who is a plain room member', { roomRoles: [], workspaceRoles: ['admin'] }],
  ])('lets %s change the room settings', async (_label, roles) => {
    await settingsSetTool.execute({ key: 'speakerMatchThreshold', value: 0.5 }, context(roles), {} as never);
    expect(store.app_settings.map((r) => r.key)).toEqual(['room:room-1:speakerMatchThreshold']);
  });

  it('rejects a plain room member', async () => {
    await expect(
      settingsSetTool.execute({ key: 'keepOriginalAudio', value: true }, context({ roomRoles: [], workspaceRoles: ['user'] }), {} as never),
    ).rejects.toThrow(/owners, moderators/);
    expect(store.app_settings).toHaveLength(0);
  });

  it('fails closed when the dispatch carries no role signal (scope not granted, managed runtime)', async () => {
    await expect(settingsSetTool.execute({ key: 'sttRealtimeProvider', value: 'elevenlabs' }, context(), {} as never)).rejects.toThrow(
      /owners, moderators/,
    );
    expect(store.app_settings).toHaveLength(0);
  });

  it('ignores admin-looking claims that are not the signed workspace_roles', async () => {
    const forged = context();
    (forged.actor as { claims: Record<string, unknown> }).claims = { isAdmin: true, roles: ['admin'], role: 'admin' };
    await expect(settingsSetTool.execute({ key: 'speakerMatchThreshold', value: 0.5 }, forged, {} as never)).rejects.toThrow(/owners, moderators/);
  });

  it('rejects a caller that is not bound to a room', async () => {
    const roomless = context({ roomRoles: ['owner'] });
    (roomless.actor as { roomId?: string }).roomId = undefined;
    await expect(settingsSetTool.execute({ key: 'speakerMatchThreshold', value: 0.5 }, roomless, {} as never)).rejects.toThrow(/owners, moderators/);
  });

  it('rejects an unsupported key even for an owner', async () => {
    await expect(settingsSetTool.execute({ key: 'notARealKey', value: 1 }, context({ roomRoles: ['owner'] }), {} as never)).rejects.toThrow(/not supported/);
  });

  it('rejects an out-of-range threshold', async () => {
    await expect(
      settingsSetTool.execute({ key: 'speakerMatchThreshold', value: 1.5 }, context({ roomRoles: ['owner'] }), {} as never),
    ).rejects.toThrow(/range/);
  });

  it('persists a valid setting into app_settings', async () => {
    const result = (await settingsSetTool.execute(
      { key: 'sttRealtimeProvider', value: 'elevenlabs' },
      context({ roomRoles: ['owner'] }),
      {} as never,
    )) as { settings: Record<string, unknown> };
    expect(result.settings).toEqual({ sttRealtimeProvider: 'elevenlabs' });
    expect(store.app_settings).toHaveLength(1);
    expect(JSON.parse(String(store.app_settings[0].valueJson))).toBe('elevenlabs');
  });
});
