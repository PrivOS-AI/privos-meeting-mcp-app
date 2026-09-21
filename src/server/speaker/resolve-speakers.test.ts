import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let rangeMarkers: Map<string, number>;

// Cosine similarity is magnitude-invariant, so two markers that are just
// different SCALES of the same direction (e.g. 0.9 vs 0.1) would score
// cos≈1 — not a useful stand-in for "different voice". Each marker below
// maps to a genuinely different (orthogonal-ish) direction instead, so
// same-marker calls are highly coherent (cos≈1) and different-marker calls
// are clearly incoherent (cos≈0), matching what a real embedding space does.
const VOICE_DIRECTIONS: Record<number, readonly number[]> = {
  0.9: [1, 0, 0, 0],
  [-0.9]: [0, 1, 0, 0],
  0.1: [0, 0, 1, 0],
};

vi.mock('../media/decode-audio.js', () => ({
  readWavPcm: vi.fn(async (_path: string, startSec: number, endSec: number) => {
    const marker = rangeMarkers.get(`${startSec}:${endSec}`) ?? 0.9;
    return new Float32Array(160).fill(marker);
  }),
}));

vi.mock('./embedding-extractor.js', () => ({
  computeEmbedding: vi.fn(async (pcm: Float32Array) => {
    // `pcm` is a Float32Array — round-tripping a marker like 0.9 through it
    // loses precision (float32 vs JS double), so re-round before the object
    // lookup rather than keying on the raw (slightly off) value.
    const marker = Math.round(pcm[0] * 10) / 10;
    const direction = VOICE_DIRECTIONS[marker] ?? [marker, marker, marker, marker];
    return new Float32Array(direction);
  }),
}));

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
import * as profileStore from './profile-store.js';
import { openPendingEmbedding, resolveSpeakers } from './resolve-speakers.js';
import type { Segment } from '../transcript/segment-builder.js';

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;
const VOICE_A = 0.9;
const VOICE_B = -0.9;
const VOICE_C = 0.1;

function seg(speakerId: string, startSec: number, endSec: number): Segment {
  return { id: `seg-${speakerId}-${startSec}`, speakerId, startSec, endSec, text: 'this is a fairly long sentence', lang: 'vi', tokenCount: 6, avgConfidence: 0.9 };
}

describe('resolveSpeakers', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    env.speakerMatchThreshold = 0.5;
    env.speakerMinSegmentSec = 2;
    env.speakerEnrolTargetSec = 5;
    resetVoiceprintKeyCacheForTests();
    rangeMarkers = new Map();
    store = { speaker_profiles: [], app_settings: [] };
    fakeHub = installFakeHub({ store });
  });

  function db(): AppDbBotClient {
    return new AppDbBotClient();
  }

  it('auto-enrols a coherent cluster that matches an existing profile', async () => {
    const profile = await profileStore.createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await profileStore.enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm0', durationSec: 10, source: 'auto-post', speakerKey: 'seed' });

    const segments = [seg('spkA', 0, 3), seg('spkA', 5, 8)];
    for (const s of segments) rangeMarkers.set(`${s.startSec}:${s.endSec}`, VOICE_A);

    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1');
    expect(result.resolved).toBe(true);
    expect(result.profileId).toBe(profile.id);
    expect(result.confidence).toBeGreaterThan(0.99);
    expect(result.pendingEmbeddingJson).toBeUndefined();

    const reloaded = await profileStore.getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(2); // the pre-seeded one + the new auto-enrolment
  });

  it('parks a coherent-but-unmatched cluster as pendingEmbedding, does not touch any profile', async () => {
    const profile = await profileStore.createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await profileStore.enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm0', durationSec: 10, source: 'auto-post', speakerKey: 'seed' });

    const segments = [seg('spkC', 0, 3), seg('spkC', 5, 8)];
    for (const s of segments) rangeMarkers.set(`${s.startSec}:${s.endSec}`, VOICE_C);

    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1');
    expect(result.resolved).toBe(false);
    expect(result.profileId).toBeUndefined();
    expect(result.pendingEmbeddingJson).toBeDefined();

    const pending = openPendingEmbedding(result.pendingEmbeddingJson!, 'pending:meeting-1:spkC');
    expect(pending?.minPairwiseCosine).toBeGreaterThan(0.9); // same voice across both ranges

    const reloaded = await profileStore.getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1); // untouched
  });

  it('blocks auto-enrol AND auto-label for a bimodal (incoherent) cluster, even if it would otherwise match', async () => {
    const profile = await profileStore.createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await profileStore.enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm0', durationSec: 10, source: 'auto-post', speakerKey: 'seed' });

    // One range sounds like the registered profile, the other sounds like a totally different voice — a diarization turn that blended two speakers.
    const segments = [seg('spkBimodal', 0, 3), seg('spkBimodal', 5, 8)];
    rangeMarkers.set('0:3', VOICE_A);
    rangeMarkers.set('5:8', VOICE_B);

    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1');
    expect(result.resolved).toBe(false);
    expect(result.profileId).toBeUndefined();
    expect(result.pendingEmbeddingJson).toBeDefined();

    const pending = openPendingEmbedding(result.pendingEmbeddingJson!, 'pending:meeting-1:spkBimodal');
    expect(pending?.minPairwiseCosine).toBeLessThan(env.speakerMatchThreshold);

    const reloaded = await profileStore.getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1); // no contamination from the incoherent cluster
  });

  it('a user-identified speaker skips matching entirely and enrols into the USER\'s profile, not a different one it would otherwise match', async () => {
    // A pre-existing profile that would normally win the match (same voice direction).
    const wrongProfile = await profileStore.createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await profileStore.enrolEmbedding(db(), wrongProfile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm0', durationSec: 10, source: 'auto-post', speakerKey: 'seed' });

    const segments = [seg('spkA', 0, 3), seg('spkA', 5, 8)];
    for (const s of segments) rangeMarkers.set(`${s.startSec}:${s.endSec}`, VOICE_A);

    const userIdentityBySpeakerId = new Map([['spkA', { displayName: 'Binh', privosUserId: 'user-binh', createdByUserId: 'owner-1' }]]);
    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1', userIdentityBySpeakerId);

    expect(result.resolved).toBe(true);
    expect(result.nameSource).toBe('user');
    expect(result.displayName).toBe('Binh');
    expect(result.profileId).not.toBe(wrongProfile.id);

    const reloadedWrong = await profileStore.getProfile(db(), wrongProfile.id);
    expect(reloadedWrong?.embeddings).toHaveLength(1); // untouched — the user identity never landed here

    const created = await profileStore.findProfileByPrivosUserId(db(), 'user-binh');
    expect(created?.id).toBe(result.profileId);
    expect(created?.embeddings).toHaveLength(1);
  });

  it('reports "too little data" (no pendingEmbedding) when a speaker has no segment long/wordy enough to pick', async () => {
    const segments = [{ id: 's1', speakerId: 'spkShort', startSec: 0, endSec: 0.5, text: 'um', lang: 'vi', tokenCount: 1 }];
    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1');
    expect(result.resolved).toBe(false);
    expect(result.sampleSec).toBe(0);
    expect(result.pendingEmbeddingJson).toBeUndefined();
  });
});
