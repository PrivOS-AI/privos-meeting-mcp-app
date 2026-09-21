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
import { resetVoiceprintKeyCacheForTests, sealEmbedding } from './voiceprint-crypto.js';
import {
  EMBEDDING_CAP,
  cachedProfiles,
  createProfile,
  deleteProfile,
  enrolEmbedding,
  getProfile,
  listProfiles,
  profileHealth,
  pruneOutlierEmbeddings,
  removeEmbeddingsOfMeeting,
  resetProfileCacheForTests,
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
    resetProfileCacheForTests();
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
    await enrolEmbedding(db(), profile.id, { vector: vec(1), meetingId: 'm1', durationSec: 20, source: 'auto-post', speakerKey: 'm1' });

    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1);
    expect(reloaded?.sampleCount).toBe(1);
    expect(reloaded?.centroid).not.toBeNull();
    expect(Array.from(reloaded!.centroid!)).toEqual(Array.from(vec(1)));
  });

  it('caps embeddings at EMBEDDING_CAP, keeping only the most recent', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    for (let i = 0; i < EMBEDDING_CAP + 5; i++) {
      await enrolEmbedding(db(), profile.id, { vector: vec(i), meetingId: `m${i}`, durationSec: 10, source: 'auto-post', speakerKey: `m${i}` });
    }
    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(EMBEDDING_CAP);
    // the earliest enrolments should have been evicted, the latest kept
    expect(reloaded?.embeddings.at(-1)?.meetingId).toBe(`m${EMBEDDING_CAP + 4}`);
  });

  it('serializes concurrent enrolments for the same profile without losing any (withProfileLock + re-read)', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => enrolEmbedding(db(), profile.id, { vector: vec(i), meetingId: `m${i}`, durationSec: 5, source: 'auto-post', speakerKey: `m${i}` })),
    );
    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(10);
    expect(reloaded?.sampleCount).toBe(10);
  });

  it('enrolEmbedding with alsoReplaceSpeakerKeys purges a DIFFERENT speakerKey for the same meeting (live-then-post one-vector-per-person invariant)', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(1), meetingId: 'm1', durationSec: 21, source: 'user-live', speakerKey: 'ss-1' });
    expect((await getProfile(db(), profile.id))?.embeddings).toHaveLength(1);

    await enrolEmbedding(db(), profile.id, { vector: vec(2), meetingId: 'm1', durationSec: 30, source: 'user-post', speakerKey: 'spkA', alsoReplaceSpeakerKeys: ['ss-1'] });

    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1); // the old `ss-1` vector was purged, not kept alongside the new `spkA` one
    expect(reloaded?.embeddings[0].meetingId).toBe('m1');

    // A DIFFERENT meeting's embedding under the same alternate key is untouched — the purge is meetingId-scoped.
    await enrolEmbedding(db(), profile.id, { vector: vec(3), meetingId: 'm2', durationSec: 10, source: 'user-live', speakerKey: 'ss-1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(4), meetingId: 'm3', durationSec: 10, source: 'user-post', speakerKey: 'spkB', alsoReplaceSpeakerKeys: ['ss-1'] });
    const final = await getProfile(db(), profile.id);
    expect(final?.embeddings.map((e) => e.meetingId).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('removeEmbeddingsOfMeeting drops only the targeted meeting and recomputes centroid', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(1), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'm1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(2), meetingId: 'm2', durationSec: 10, source: 'auto-post', speakerKey: 'm2' });

    await removeEmbeddingsOfMeeting(db(), profile.id, 'm1');

    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1);
    expect(reloaded?.embeddings[0].meetingId).toBe('m2');
  });

  it('listProfiles decodes every embedding across all profiles', async () => {
    const p1 = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    const p2 = await createProfile(db(), { displayName: 'Binh', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), p1.id, { vector: vec(1), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'm1' });
    await enrolEmbedding(db(), p2.id, { vector: vec(2), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'm1' });

    const all = await listProfiles(db());
    expect(all.map((p) => p.displayName).sort()).toEqual(['An', 'Binh']);
    expect(all.find((p) => p.id === p1.id)?.embeddings).toHaveLength(1);
  });

  it('deleteProfile removes the profile row AND clears meeting_speakers links in every known room', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(1), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'm1' });

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

/** Builds a raw sealed-embedding-envelope JSON string directly (bypassing `enrolEmbedding`) so a test can seed a profile row with an EXACT source mix/order, including a `legacy` (no `source` field) entry `enrolEmbedding` can never produce on its own. */
function rawEmbeddingJson(
  profileId: string,
  seed: number,
  meta: { meetingId: string; speakerKey: string; source?: 'user-live' | 'user-post' | 'auto-post' },
): string {
  const sealed = sealEmbedding(vec(seed), { profileId, createdAt: `t-${seed}` });
  const envelope: Record<string, unknown> = { ...sealed, meetingId: meta.meetingId, durationSec: 10, speakerKey: meta.speakerKey };
  if (meta.source) envelope.source = meta.source;
  return JSON.stringify(envelope);
}

function seedRowEmbeddings(profileId: string, items: { seed: number; meetingId: string; speakerKey: string; source?: 'user-live' | 'user-post' | 'auto-post' }[]): void {
  const row = store.speaker_profiles.find((r) => r._id === profileId)!;
  row.embeddings = items.map((it) => rawEmbeddingJson(profileId, it.seed, it));
  row.sampleCount = items.length;
}

describe('profile-store: source-aware eviction (never FIFO across sources)', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    resetVoiceprintKeyCacheForTests();
    resetProfileCacheForTests();
    store = { speaker_profiles: [], meeting_speakers: [] };
    fakeHub = installFakeHub({ store });
  });

  function db(): AppDbBotClient {
    return new AppDbBotClient();
  }

  it('evicts the oldest auto-post vector first, never touching legacy or user-live', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    const items = [
      { seed: 1, meetingId: 'legacy-1', speakerKey: 'k1' }, // legacy (no `source`)
      { seed: 2, meetingId: 'live-1', speakerKey: 'k2', source: 'user-live' as const },
      { seed: 3, meetingId: 'auto-oldest', speakerKey: 'k3', source: 'auto-post' as const }, // oldest auto-post
      ...Array.from({ length: 17 }, (_, i) => ({ seed: 10 + i, meetingId: `auto-${i}`, speakerKey: `ak${i}`, source: 'auto-post' as const })),
    ];
    expect(items).toHaveLength(EMBEDDING_CAP);
    seedRowEmbeddings(profile.id, items);

    await enrolEmbedding(db(), profile.id, { vector: vec(99), meetingId: 'auto-new', durationSec: 10, source: 'auto-post', speakerKey: 'new' });

    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(EMBEDDING_CAP);
    const meetingIds = reloaded!.embeddings.map((e) => e.meetingId);
    expect(meetingIds).not.toContain('auto-oldest'); // evicted
    expect(meetingIds).toContain('legacy-1'); // untouched
    expect(meetingIds).toContain('live-1'); // untouched
  });

  it('evicts the oldest legacy vector once no auto-post vector remains', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    const items = [
      { seed: 1, meetingId: 'legacy-oldest', speakerKey: 'k1' }, // legacy, oldest
      { seed: 2, meetingId: 'legacy-2', speakerKey: 'k2' }, // legacy
      ...Array.from({ length: 8 }, (_, i) => ({ seed: 10 + i, meetingId: `live-${i}`, speakerKey: `lk${i}`, source: 'user-live' as const })),
      ...Array.from({ length: 10 }, (_, i) => ({ seed: 30 + i, meetingId: `post-${i}`, speakerKey: `pk${i}`, source: 'user-post' as const })), // exactly at the sub-cap, not over it
    ];
    expect(items).toHaveLength(EMBEDDING_CAP);
    seedRowEmbeddings(profile.id, items);

    await enrolEmbedding(db(), profile.id, { vector: vec(99), meetingId: 'live-new', durationSec: 10, source: 'user-live', speakerKey: 'new' });

    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(EMBEDDING_CAP);
    const meetingIds = reloaded!.embeddings.map((e) => e.meetingId);
    expect(meetingIds).not.toContain('legacy-oldest'); // evicted — no auto-post existed to absorb the overflow
    expect(meetingIds).toContain('legacy-2');
    expect(meetingIds).toContain('live-0');
    expect(reloaded!.embeddings.filter((e) => e.source === 'user-post')).toHaveLength(10); // untouched
  });

  it('evicts the oldest user-live vector once no auto-post/legacy vector remains, never a user-post one', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    const items = [
      ...Array.from({ length: 10 }, (_, i) => ({ seed: i, meetingId: `post-${i}`, speakerKey: `pk${i}`, source: 'user-post' as const })), // exactly at the sub-cap
      ...Array.from({ length: 10 }, (_, i) => ({ seed: 20 + i, meetingId: `live-${i}`, speakerKey: `lk${i}`, source: 'user-live' as const })),
    ];
    expect(items).toHaveLength(EMBEDDING_CAP);
    // Order: `live-0` is the OLDEST user-live entry (index 10, right after the 10 user-post entries).
    seedRowEmbeddings(profile.id, items);

    await enrolEmbedding(db(), profile.id, { vector: vec(99), meetingId: 'live-new', durationSec: 10, source: 'user-live', speakerKey: 'new' });

    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(EMBEDDING_CAP);
    const meetingIds = reloaded!.embeddings.map((e) => e.meetingId);
    expect(meetingIds).not.toContain('live-0'); // oldest user-live evicted
    expect(reloaded!.embeddings.filter((e) => e.source === 'user-post')).toHaveLength(10); // never touched
  });

  it('25 auto-post enrols never remove a user-post vector', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(1), meetingId: 'up-1', durationSec: 10, source: 'user-post', speakerKey: 'up1' });
    await enrolEmbedding(db(), profile.id, { vector: vec(2), meetingId: 'up-2', durationSec: 10, source: 'user-post', speakerKey: 'up2' });

    for (let i = 0; i < 25; i++) {
      await enrolEmbedding(db(), profile.id, { vector: vec(10 + i), meetingId: `auto-${i}`, durationSec: 10, source: 'auto-post', speakerKey: `ak${i}` });
    }

    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(EMBEDDING_CAP);
    const meetingIds = reloaded!.embeddings.map((e) => e.meetingId);
    expect(meetingIds).toContain('up-1');
    expect(meetingIds).toContain('up-2');
    expect(reloaded!.embeddings.filter((e) => e.source === 'user-post')).toHaveLength(2);
  });

  it('user-post vectors beyond the 10-subcap are evicted only by another user-post vector, oldest first', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    for (let i = 0; i < 10; i++) {
      await enrolEmbedding(db(), profile.id, { vector: vec(i), meetingId: `up-${i}`, durationSec: 10, source: 'user-post', speakerKey: `upk${i}` });
    }
    // 5 auto-post on top — total (15) is well under EMBEDDING_CAP, so nothing should be evicted by the global cap.
    for (let i = 0; i < 5; i++) {
      await enrolEmbedding(db(), profile.id, { vector: vec(100 + i), meetingId: `auto-${i}`, durationSec: 10, source: 'auto-post', speakerKey: `apk${i}` });
    }
    let reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings.filter((e) => e.source === 'user-post')).toHaveLength(10);
    expect(reloaded?.embeddings.filter((e) => e.source === 'auto-post')).toHaveLength(5);

    // An 11th user-post enrol pushes the sub-cap over 10 -> the OLDEST user-post (up-0) is evicted, never an auto-post one.
    await enrolEmbedding(db(), profile.id, { vector: vec(999), meetingId: 'up-10', durationSec: 10, source: 'user-post', speakerKey: 'upk10' });
    reloaded = await getProfile(db(), profile.id);
    const meetingIds = reloaded!.embeddings.map((e) => e.meetingId);
    expect(meetingIds).not.toContain('up-0');
    expect(reloaded!.embeddings.filter((e) => e.source === 'user-post')).toHaveLength(10);
    expect(reloaded!.embeddings.filter((e) => e.source === 'auto-post')).toHaveLength(5); // untouched
  });
});

describe('profile-store: cachedProfiles/invalidateProfileCache', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    resetVoiceprintKeyCacheForTests();
    resetProfileCacheForTests();
    store = { speaker_profiles: [], meeting_speakers: [] };
    fakeHub = installFakeHub({ store });
  });

  function db(): AppDbBotClient {
    return new AppDbBotClient();
  }

  it('serves listProfiles from cache, but enrolEmbedding invalidates it automatically', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    const first = await cachedProfiles(db());
    expect(first.find((p) => p.id === profile.id)?.embeddings).toHaveLength(0);

    await enrolEmbedding(db(), profile.id, { vector: vec(1), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'k1' });

    const second = await cachedProfiles(db());
    expect(second.find((p) => p.id === profile.id)?.embeddings).toHaveLength(1); // NOT stale — a person named live in this process becomes matchable right away
  });

  it('pruneOutlierEmbeddings also invalidates the cache', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'k1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0.99, 0.01, 0, 0]), meetingId: 'm2', durationSec: 10, source: 'auto-post', speakerKey: 'k2' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0.98, 0.02, 0, 0]), meetingId: 'm3', durationSec: 10, source: 'auto-post', speakerKey: 'k3' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0, 1, 0, 0]), meetingId: 'm4', durationSec: 10, source: 'auto-post', speakerKey: 'k4' });
    await cachedProfiles(db()); // warm the cache

    await pruneOutlierEmbeddings(db(), profile.id, 0.5);

    const after = await cachedProfiles(db());
    expect(after.find((p) => p.id === profile.id)?.embeddings).toHaveLength(3);
  });
});

describe('profileHealth', () => {
  it('reports neutral scalars for fewer than 2 vectors', () => {
    const profile = { id: 'p1', displayName: 'An', colorKey: 'blue', createdByUserId: 'u1', embeddings: [], centroid: null, dim: 4, sampleCount: 0 };
    expect(profileHealth(profile, 0.5)).toEqual({
      vectorCounts: { userLive: 0, userPost: 0, autoPost: 0, legacy: 0 },
      minPairwiseCosine: 1,
      meanPairwiseCosine: 1,
      outlierCount: 0,
    });
  });

  it('counts vectors by source, treating an absent `source` as legacy', () => {
    const profile = {
      id: 'p1',
      displayName: 'An',
      colorKey: 'blue',
      createdByUserId: 'u1',
      dim: 4,
      sampleCount: 3,
      centroid: null,
      embeddings: [
        { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm1', durationSec: 10, createdAt: 'now', speakerKey: 'k1', source: 'user-live' as const },
        { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm2', durationSec: 10, createdAt: 'now', speakerKey: 'k2', source: 'auto-post' as const },
        { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm3', durationSec: 10, createdAt: 'now', speakerKey: 'k3' }, // legacy
      ],
    };
    const health = profileHealth(profile, 0.5);
    expect(health.vectorCounts).toEqual({ userLive: 1, userPost: 0, autoPost: 1, legacy: 1 });
    expect(health.minPairwiseCosine).toBeCloseTo(1); // all identical vectors
    expect(health.meanPairwiseCosine).toBeCloseTo(1);
    expect(health.outlierCount).toBe(0);
  });

  it('flags exactly the vector whose mean cosine to the rest falls below the match threshold', () => {
    const profile = {
      id: 'p1',
      displayName: 'An',
      colorKey: 'blue',
      createdByUserId: 'u1',
      dim: 4,
      sampleCount: 4,
      centroid: null,
      embeddings: [
        { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm1', durationSec: 10, createdAt: 'now', speakerKey: 'k1', source: 'auto-post' as const },
        { vector: new Float32Array([0.99, 0.01, 0, 0]), meetingId: 'm2', durationSec: 10, createdAt: 'now', speakerKey: 'k2', source: 'auto-post' as const },
        { vector: new Float32Array([0.98, 0.02, 0, 0]), meetingId: 'm3', durationSec: 10, createdAt: 'now', speakerKey: 'k3', source: 'auto-post' as const },
        { vector: new Float32Array([0, 1, 0, 0]), meetingId: 'm4', durationSec: 10, createdAt: 'now', speakerKey: 'k4', source: 'auto-post' as const }, // orthogonal outlier
      ],
    };
    const health = profileHealth(profile, 0.5);
    expect(health.outlierCount).toBe(1);
  });
});

describe('pruneOutlierEmbeddings', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    resetVoiceprintKeyCacheForTests();
    resetProfileCacheForTests();
    store = { speaker_profiles: [], meeting_speakers: [] };
    fakeHub = installFakeHub({ store });
  });

  function db(): AppDbBotClient {
    return new AppDbBotClient();
  }

  it('removes a flagged auto-post outlier, keeping the coherent core untouched', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'k1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0.99, 0.01, 0, 0]), meetingId: 'm2', durationSec: 10, source: 'auto-post', speakerKey: 'k2' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0.98, 0.02, 0, 0]), meetingId: 'm3', durationSec: 10, source: 'auto-post', speakerKey: 'k3' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0, 1, 0, 0]), meetingId: 'm4', durationSec: 10, source: 'auto-post', speakerKey: 'k4' }); // orthogonal outlier

    const result = await pruneOutlierEmbeddings(db(), profile.id, 0.5);
    expect(result).toEqual({ removed: 1, remaining: 3 });
    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings.map((e) => e.meetingId).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('never removes a user-post vector, even when it scores as the flagged outlier', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'k1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0.99, 0.01, 0, 0]), meetingId: 'm2', durationSec: 10, source: 'auto-post', speakerKey: 'k2' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0.98, 0.02, 0, 0]), meetingId: 'm3', durationSec: 10, source: 'auto-post', speakerKey: 'k3' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0, 1, 0, 0]), meetingId: 'm4', durationSec: 10, source: 'user-post', speakerKey: 'k4' }); // outlier, but human-confirmed

    const result = await pruneOutlierEmbeddings(db(), profile.id, 0.5);
    expect(result).toEqual({ removed: 0, remaining: 4 }); // nothing PRUNABLE — the only outlier is user-*
    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(4);
  });

  it('refuses to drop a profile below 1 vector — removes at most count-1 of the worst outliers', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'k1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0, 1, 0, 0]), meetingId: 'm2', durationSec: 10, source: 'auto-post', speakerKey: 'k2' });

    const result = await pruneOutlierEmbeddings(db(), profile.id, 0.5);
    expect(result).toEqual({ removed: 1, remaining: 1 });
    const reloaded = await getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1);
  });

  it('is a no-op when nothing is flagged', async () => {
    const profile = await createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm1', durationSec: 10, source: 'auto-post', speakerKey: 'k1' });
    await enrolEmbedding(db(), profile.id, { vector: new Float32Array([0.99, 0.01, 0, 0]), meetingId: 'm2', durationSec: 10, source: 'auto-post', speakerKey: 'k2' });

    const result = await pruneOutlierEmbeddings(db(), profile.id, 0.5);
    expect(result).toEqual({ removed: 0, remaining: 2 });
  });

  it('throws when the profile no longer exists', async () => {
    await expect(pruneOutlierEmbeddings(db(), 'missing-profile', 0.5)).rejects.toThrow();
  });
});
