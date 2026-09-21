import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

import { env } from '../env.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { installFakeHub, type Store } from '../tools/test-support/fake-hub.js';
import { resetVoiceprintKeyCacheForTests } from './voiceprint-crypto.js';
import {
  EMBEDDING_CAP,
  createProfile,
  deleteProfile,
  enrolEmbedding,
  getProfile,
  listProfiles,
  removeEmbeddingsOfMeeting,
} from './profile-store.js';

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

function vec(seed: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed + i);
  return v;
}

describe('profile-store', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    resetVoiceprintKeyCacheForTests();
    store = { speaker_profiles: [], meeting_speakers: [] };
    fakeHub = installFakeHub({ store });
  });

  function db(): AppDbBotClient {
    return new AppDbBotClient();
  }

  it('creates a profile with a normalized name and no embeddings', async () => {
    const profile = await createProfile(db(), { displayName: 'An Nguyễn', createdByUserId: 'user-1', createdInRoomId: 'room-1' });
    expect(profile.displayName).toBe('An Nguyễn');
    expect(profile.embeddings).toEqual([]);
    expect(profile.sampleCount).toBe(0);
  });

  it('enrols an embedding: pushes, recomputes centroid, bumps sampleCount', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(1), meetingId: 'm1', durationSec: 20 });

    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1);
    expect(reloaded?.sampleCount).toBe(1);
    expect(reloaded?.centroid).not.toBeNull();
    expect(Array.from(reloaded!.centroid!)).toEqual(Array.from(vec(1)));
  });

  it('caps embeddings at EMBEDDING_CAP, keeping only the most recent', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    for (let i = 0; i < EMBEDDING_CAP + 5; i++) {
      await enrolEmbedding(db(), profile.id, { vector: vec(i), meetingId: `m${i}`, durationSec: 10 });
    }
    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(EMBEDDING_CAP);
    // the earliest enrolments should have been evicted, the latest kept
    expect(reloaded?.embeddings.at(-1)?.meetingId).toBe(`m${EMBEDDING_CAP + 4}`);
  });

  it('serializes concurrent enrolments for the same profile without losing any (withProfileLock + re-read)', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => enrolEmbedding(db(), profile.id, { vector: vec(i), meetingId: `m${i}`, durationSec: 5 })),
    );
    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(10);
    expect(reloaded?.sampleCount).toBe(10);
  });

  it('removeEmbeddingsOfMeeting drops only the targeted meeting and recomputes centroid', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(1), meetingId: 'm1', durationSec: 10 });
    await enrolEmbedding(db(), profile.id, { vector: vec(2), meetingId: 'm2', durationSec: 10 });

    await removeEmbeddingsOfMeeting(db(), profile.id, 'm1');

    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1);
    expect(reloaded?.embeddings[0].meetingId).toBe('m2');
  });

  it('listProfiles decodes every embedding across all profiles', async () => {
    const p1 = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    const p2 = await createProfile(db(), { displayName: 'Binh', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), p1.id, { vector: vec(1), meetingId: 'm1', durationSec: 10 });
    await enrolEmbedding(db(), p2.id, { vector: vec(2), meetingId: 'm1', durationSec: 10 });

    const all = await listProfiles(db());
    expect(all.map((p) => p.displayName).sort()).toEqual(['An', 'Binh']);
    expect(all.find((p) => p.id === p1.id)?.embeddings).toHaveLength(1);
  });

  it('deleteProfile removes the profile row AND clears meeting_speakers links in every known room', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(1), meetingId: 'm1', durationSec: 10 });

    store.meeting_speakers = [
      { _id: 'ms1', meeting: 'm1', profileId: profile.id, pendingEmbedding: 'stale-ciphertext', roomId: 'room-a' },
      { _id: 'ms2', meeting: 'm2', profileId: profile.id, pendingEmbedding: '', roomId: 'room-b' },
      { _id: 'ms3', meeting: 'm3', profileId: 'other-profile', pendingEmbedding: '', roomId: 'room-a' },
    ];

    await deleteProfile(db(), profile.id, ['room-a', 'room-b']);

    expect(await getProfile(db(), profile.id)).toBeNull();
    const ms1 = store.meeting_speakers.find((r) => r._id === 'ms1')!;
    const ms2 = store.meeting_speakers.find((r) => r._id === 'ms2')!;
    const ms3 = store.meeting_speakers.find((r) => r._id === 'ms3')!;
    expect(ms1.profileId).toBe('');
    expect(ms1.pendingEmbedding).toBe('');
    expect(ms2.profileId).toBe('');
    expect(ms3.profileId).toBe('other-profile'); // untouched — different profile
  });
});
