import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

import { env } from '../env.js';
import { resetVoiceprintKeyCacheForTests, sealEmbedding } from '../speaker/voiceprint-crypto.js';
import { installFakeHub, type Store } from './test-support/fake-hub.js';

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { forgetVoiceprintsTool } = await import('./forget-voiceprints-tool.js');

function ctx(userId = 'owner-1'): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' } };
}

function sample(profileId: string, meetingId: string): string {
  return JSON.stringify({ ...sealEmbedding(new Float32Array([1, 0, 0, 0]), { profileId, createdAt: 'now' }), meetingId, durationSec: 15 });
}

describe('meeting_forget_voiceprints', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    resetVoiceprintKeyCacheForTests();
    store = {
      meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'owner-1' }],
      speaker_profiles: [
        // Someone else's profile that a sample from meeting-1 was added to, plus one from another meeting.
        { _id: 'p-alice', displayName: 'Alice', displayNameNormalized: 'alice', createdByUserId: 'someone-else', embeddings: [sample('p-alice', 'meeting-1'), sample('p-alice', 'meeting-9')], centroid: '', dim: 4, sampleCount: 2 },
        { _id: 'p-bob', displayName: 'Bob', displayNameNormalized: 'bob', createdByUserId: 'owner-1', embeddings: [sample('p-bob', 'meeting-9')], centroid: '', dim: 4, sampleCount: 1 },
      ],
      app_settings: [],
    };
    fakeHub = installFakeHub({ store });
  });

  it("removes this meeting's samples from every profile and keeps the others", async () => {
    const result = (await forgetVoiceprintsTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, ctx(), {} as never)) as { profilesChanged: number };
    expect(result.profilesChanged).toBe(1);
    expect(store.speaker_profiles.find((p) => p._id === 'p-alice')?.sampleCount).toBe(1);
    expect(store.speaker_profiles.find((p) => p._id === 'p-bob')?.sampleCount).toBe(1);
  });

  it('is idempotent', async () => {
    await forgetVoiceprintsTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, ctx(), {} as never);
    const again = (await forgetVoiceprintsTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, ctx(), {} as never)) as { profilesChanged: number };
    expect(again.profilesChanged).toBe(0);
  });

  it('refuses anyone but the meeting owner', async () => {
    await expect(forgetVoiceprintsTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, ctx('someone-else'), {} as never)).rejects.toMatchObject({ code: 'NOT_MEETING_OWNER' });
    expect(store.speaker_profiles.find((p) => p._id === 'p-alice')?.sampleCount).toBe(2);
  });
});
