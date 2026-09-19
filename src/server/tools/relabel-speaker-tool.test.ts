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

const { relabelSpeakerTool } = await import('./relabel-speaker-tool.js');

function ctx(userId = 'owner-1'): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' } };
}

describe('meeting_relabel_speaker', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    resetVoiceprintKeyCacheForTests();

    const sealedForWrongProfile = sealEmbedding(new Float32Array([1, 0, 0, 0]), { profileId: 'profile-wrong', createdAt: 'now' });
    store = {
      meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'owner-1' }],
      meeting_speakers: [{ _id: 'ms1', meeting: 'meeting-1', speakerId: 'spk1', profileId: 'profile-wrong', resolved: true, displayName: 'Wrong name' }],
      speaker_profiles: [
        {
          _id: 'profile-wrong',
          displayName: 'Wrong name',
          displayNameNormalized: 'wrong name',
          createdByUserId: 'owner-1',
          embeddings: [JSON.stringify({ ...sealedForWrongProfile, meetingId: 'meeting-1', durationSec: 15 })],
          centroid: '',
          dim: 4,
          sampleCount: 1,
        },
        { _id: 'profile-correct', displayName: 'Correct name', displayNameNormalized: 'correct name', createdByUserId: 'owner-1', embeddings: [], centroid: '', dim: 0, sampleCount: 0 },
      ],
      app_settings: [],
    };
    fakeHub = installFakeHub({ store });
  });

  it('rejects a non-owner', async () => {
    await expect(
      relabelSpeakerTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', speakerId: 'spk1', profileId: 'profile-correct' }, ctx('someone-else'), {} as never),
    ).rejects.toThrow(/meeting owner/);
  });

  it('moves the meeting embedding from the old profile to the new one (back-propagation)', async () => {
    const result = (await relabelSpeakerTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', speakerId: 'spk1', profileId: 'profile-correct' },
      ctx(),
      {} as never,
    )) as { updated: boolean; profileId: string; enrolled: boolean };

    expect(result).toMatchObject({ updated: true, profileId: 'profile-correct', enrolled: true });
    expect(store.speaker_profiles.find((p) => p._id === 'profile-wrong')?.embeddings).toHaveLength(0);
    expect(store.speaker_profiles.find((p) => p._id === 'profile-correct')?.embeddings).toHaveLength(1);
    expect(store.meeting_speakers[0].profileId).toBe('profile-correct');
    expect(store.meeting_speakers[0].displayName).toBe('Correct name');
  });

  it('creates a new profile by name when no profileId is given', async () => {
    await relabelSpeakerTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', speakerId: 'spk1', displayName: 'New person' }, ctx(), {} as never);
    const created = store.speaker_profiles.find((p) => p.displayName === 'New person');
    expect(created).toBeDefined();
    expect(created?.embeddings).toHaveLength(1);
  });

  it('rejects when neither profileId nor displayName is given', async () => {
    await expect(relabelSpeakerTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', speakerId: 'spk1' }, ctx(), {} as never)).rejects.toThrow(/profileId or displayName/);
  });
});
