import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

function context(userId: string): ToolCallContext {
  return {
    transport: 'direct',
    identityState: 'verified',
    sessionScope: 'test',
    actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' },
  };
}

const { liveSpeakersTool } = await import('./live-speakers-tool.js');

describe('meeting_live_speakers', () => {
  beforeEach(() => {
    store = {
      meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'user-1', status: 'recording' }],
      meeting_speakers: [
        {
          _id: 'ms-1',
          meeting: 'meeting-1',
          sessionSpeakerId: 'ss-1',
          sonioxLabels: ['s0:1'],
          displayName: 'An',
          profileId: 'profile-1',
          liveConfidence: 0.8,
          liveSpeechSec: 12,
          colorKey: 'blue',
          resolved: true,
          pendingEmbedding: JSON.stringify({ ct: 'secret-ciphertext', iv: 'x', tag: 'y', hmac: 'z', profileId: 'live:m:ss-1', createdAt: 'now' }),
        },
      ],
      app_settings: [],
    };
    fakeHub = installFakeHub({ store });
  });

  it('any room member (not just the owner) can read live speakers', async () => {
    const raw = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never)) as {
      sessionSpeakers: Array<Record<string, unknown>>;
      labelsSupported: boolean;
    };
    expect(raw.labelsSupported).toBe(true);
    expect(raw.sessionSpeakers).toHaveLength(1);
    expect(raw.sessionSpeakers[0]).toMatchObject({ sessionSpeakerId: 'ss-1', displayName: 'An', profileId: 'profile-1', resolved: true });
  });

  it('never leaks pendingEmbedding or any vector-shaped field', async () => {
    const raw = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never)) as {
      sessionSpeakers: Array<Record<string, unknown>>;
    };
    const json = JSON.stringify(raw);
    expect(json).not.toMatch(/pendingEmbedding/);
    expect(json).not.toMatch(/secret-ciphertext/);
  });

  it('returns labelsSupported:false and an empty list for a degraded (ElevenLabs) meeting', async () => {
    store.app_settings.push({ _id: 'row-1', key: 'room:room-1:sttRealtimeProvider', valueJson: JSON.stringify('elevenlabs') });
    const raw = (await liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-2'), {} as never)) as {
      sessionSpeakers: unknown[];
      labelsSupported: boolean;
    };
    expect(raw.labelsSupported).toBe(false);
    expect(raw.sessionSpeakers).toEqual([]);
  });

  it('rejects a caller outside the room', async () => {
    await expect(
      liveSpeakersTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, { ...context('user-2'), actor: { userId: 'user-2', roomId: 'room-2', claims: {}, provenance: 'user-token' } }, {} as never),
    ).rejects.toThrow();
  });
});
