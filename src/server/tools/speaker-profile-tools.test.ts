import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));
// Known rooms now live in the node-local store, not app_settings; delete sweeps this list.
vi.mock('../jobs/known-rooms-store.js', () => ({ readKnownRooms: async () => ['room-a', 'room-b'] }));

import { env } from '../env.js';
import { resetVoiceprintKeyCacheForTests, sealEmbedding } from '../speaker/voiceprint-crypto.js';
import { installFakeHub, type Store } from './test-support/fake-hub.js';

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { speakerProfileDeleteTool, speakerProfileListTool, speakerProfileUpdateTool } = await import('./speaker-profile-tools.js');

function ctx(userId: string, claims: Record<string, unknown> = {}): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId: 'room-1', claims, provenance: 'user-token' } };
}

function profileRow(overrides: Record<string, unknown>) {
  const createdAt = new Date().toISOString();
  const sealed = sealEmbedding(new Float32Array([1, 0, 0, 0]), { profileId: overrides._id as string, createdAt });
  return {
    displayName: 'An',
    displayNameNormalized: 'an',
    createdByUserId: 'owner-1',
    embeddings: [JSON.stringify({ ...sealed, meetingId: 'm1', durationSec: 10 })],
    centroid: '',
    dim: 4,
    sampleCount: 1,
    ...overrides,
  };
}

describe('speaker_profile_list/_update/_delete', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    resetVoiceprintKeyCacheForTests();
    store = {
      speaker_profiles: [{ _id: 'profile-1', ...profileRow({ _id: 'profile-1' }) }],
      meeting_speakers: [],
      app_settings: [],
    };
    fakeHub = installFakeHub({ store });
  });

  it('list never includes embeddings/centroid — display fields only', async () => {
    const result = (await speakerProfileListTool.execute({}, ctx('anyone'), {} as never)) as { profiles: Array<Record<string, unknown>> };
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).not.toHaveProperty('embeddings');
    expect(result.profiles[0]).not.toHaveProperty('centroid');
    expect(result.profiles[0].displayName).toBe('An');
    expect(result.profiles[0].meetingCount).toBe(1);
  });

  it('update rejects a caller who is neither the creator nor an admin', async () => {
    await expect(
      speakerProfileUpdateTool.execute({ profileId: 'profile-1', displayName: 'Binh' }, ctx('someone-else'), {} as never),
    ).rejects.toThrow(/workspace admin/);
  });

  it('update allows the creator to rename', async () => {
    await speakerProfileUpdateTool.execute({ profileId: 'profile-1', displayName: 'Binh' }, ctx('owner-1'), {} as never);
    expect(store.speaker_profiles[0].displayName).toBe('Binh');
  });

  it('update allows a workspace admin (via claims) even when not the creator', async () => {
    await speakerProfileUpdateTool.execute({ profileId: 'profile-1', displayName: 'Binh' }, ctx('admin-1', { role: 'admin' }), {} as never);
    expect(store.speaker_profiles[0].displayName).toBe('Binh');
  });

  it('update rejects action:"reenrol" with a clear not-yet-supported error', async () => {
    await expect(speakerProfileUpdateTool.execute({ profileId: 'profile-1', action: 'reenrol' }, ctx('owner-1'), {} as never)).rejects.toThrow(/not supported/);
  });

  it('delete rejects a non-creator, non-admin caller', async () => {
    await expect(speakerProfileDeleteTool.execute({ profileId: 'profile-1' }, ctx('someone-else'), {} as never)).rejects.toThrow(/workspace admin/);
  });

  it('delete removes the profile row and purges links across every known room', async () => {
    store.meeting_speakers = [
      { _id: 'ms1', profileId: 'profile-1', pendingEmbedding: 'x' },
      { _id: 'ms2', profileId: 'profile-1', pendingEmbedding: '' },
    ];

    const result = (await speakerProfileDeleteTool.execute({ profileId: 'profile-1' }, ctx('owner-1'), {} as never)) as { deleted: boolean };
    expect(result.deleted).toBe(true);
    expect(store.speaker_profiles).toHaveLength(0);
    expect(store.meeting_speakers.every((r) => r.profileId === '' && r.pendingEmbedding === '')).toBe(true);
  });
});
