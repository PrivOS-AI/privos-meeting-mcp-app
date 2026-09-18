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
import { sealPendingEmbedding } from '../speaker/resolve-speakers.js';
import { resetVoiceprintKeyCacheForTests } from '../speaker/voiceprint-crypto.js';
import { installFakeHub, type Store } from './test-support/fake-hub.js';

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { speakerResolveTool } = await import('./speaker-resolve-tool.js');

function ctx(userId = 'owner-1'): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' } };
}

function coherentPending(): string {
  return sealPendingEmbedding(new Float32Array([1, 0, 0, 0]), { profileId: 'pending:meeting-1:spk1', minPairwiseCosine: 0.98, rangeCount: 2, durationSec: 12 });
}

function incoherentPending(): string {
  return sealPendingEmbedding(new Float32Array([0.5, 0.5, 0, 0]), { profileId: 'pending:meeting-1:spk1', minPairwiseCosine: -0.9, rangeCount: 2, durationSec: 12 });
}

describe('speaker_resolve', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    env.speakerMatchThreshold = 0.5;
    resetVoiceprintKeyCacheForTests();
    store = {
      meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'owner-1' }],
      meeting_speakers: [{ _id: 'ms1', meeting: 'meeting-1', speakerId: 'spk1', resolved: false, pendingEmbedding: coherentPending() }],
      speaker_profiles: [],
      app_settings: [],
    };
    fakeHub = installFakeHub({ store });
  });

  it('rejects a non-owner', async () => {
    await expect(
      speakerResolveTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'skip' }] }, ctx('someone-else'), {} as never),
    ).rejects.toThrow(/chủ cuộc họp/);
  });

  it('mode "name" creates a new profile and enrols when the cluster is coherent', async () => {
    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'name', displayName: 'An Nguyễn' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ speakerId: string; enrolled: boolean; profileId?: string }> };

    expect(result.resolved[0].enrolled).toBe(true);
    expect(store.speaker_profiles).toHaveLength(1);
    expect(store.speaker_profiles[0].displayName).toBe('An Nguyễn');
    expect(store.meeting_speakers[0].resolved).toBe(true);
  });

  it('mode "name" sets the display name but does NOT enrol when the cluster is incoherent (bimodal)', async () => {
    store.meeting_speakers[0].pendingEmbedding = incoherentPending();
    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'name', displayName: 'Nhóm hai người' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ enrolled: boolean; reason?: string }> };

    expect(result.resolved[0].enrolled).toBe(false);
    expect(result.resolved[0].reason).toBe('cluster_not_coherent');
    expect(store.speaker_profiles).toHaveLength(0);
    expect(store.meeting_speakers[0].displayName).toBe('Nhóm hai người');
  });

  it('mode "user" is rejected per-assignment when the cluster is incoherent', async () => {
    store.meeting_speakers[0].pendingEmbedding = incoherentPending();
    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'user', privosUserId: 'user-42' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ enrolled: boolean; reason?: string }> };

    expect(result.resolved[0]).toEqual({ speakerId: 'spk1', enrolled: false, reason: 'cluster_not_coherent' });
    expect(store.speaker_profiles).toHaveLength(0);
  });

  it('mode "merge" enrols into the existing target profile', async () => {
    store.speaker_profiles = [{ _id: 'profile-x', displayName: 'Binh', displayNameNormalized: 'binh', createdByUserId: 'owner-1', embeddings: [], centroid: '', dim: 0, sampleCount: 0 }];
    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'merge', profileId: 'profile-x' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ enrolled: boolean; profileId?: string }> };

    expect(result.resolved[0]).toMatchObject({ enrolled: true, profileId: 'profile-x' });
    expect(store.speaker_profiles[0].sampleCount).toBe(1);
  });

  it('is idempotent — resolving an already-resolved speaker again is a no-op', async () => {
    store.meeting_speakers[0].resolved = true;
    store.meeting_speakers[0].profileId = 'profile-y';
    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'name', displayName: 'Khác' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ enrolled: boolean; reason?: string; profileId?: string }> };
    expect(result.resolved[0]).toEqual({ speakerId: 'spk1', enrolled: true, profileId: 'profile-y', reason: 'already_resolved' });
  });

  it('never clears pendingEmbedding on the row (kept until the async job clears it, not at resolve time)', async () => {
    await speakerResolveTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'name', displayName: 'An' }] }, ctx(), {} as never);
    expect(store.meeting_speakers[0].pendingEmbedding).toBeTruthy();
  });

  it('P5 quick-assign: accepts a sessionSpeakerId as speakerId when no async speakerId row matches (mid-meeting live registry row)', async () => {
    store.meeting_speakers.push({
      _id: 'ms-live',
      meeting: 'meeting-1',
      sessionSpeakerId: 'ss-42',
      resolved: false,
      pendingEmbedding: sealPendingEmbedding(new Float32Array([0, 1, 0, 0]), { profileId: 'live:meeting-1:ss-42', minPairwiseCosine: 1, rangeCount: 1, durationSec: 9 }),
    });

    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'ss-42', mode: 'name', displayName: 'Thanh' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ speakerId: string; enrolled: boolean; displayName?: string }> };

    expect(result.resolved[0]).toMatchObject({ speakerId: 'ss-42', enrolled: true, displayName: 'Thanh' });
    const liveRow = store.meeting_speakers.find((r) => r.sessionSpeakerId === 'ss-42')!;
    expect(liveRow.displayName).toBe('Thanh');
    expect(liveRow.resolved).toBe(true);
  });
});
