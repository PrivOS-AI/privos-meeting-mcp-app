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
import { setSetting } from '../hub/app-settings.js';
import { openPendingEmbedding, readMatchThreshold, resolveSpeakers } from './resolve-speakers.js';
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
    env.speakerMatchMargin = 0; // neutral default
    env.speakerAutoEnrolThreshold = 0.5; // neutral default = match threshold
    env.speakerMinSegmentSec = 2;
    env.speakerEnrolTargetSec = 5;
    resetVoiceprintKeyCacheForTests();
    profileStore.resetProfileCacheForTests();
    rangeMarkers = new Map();
    store = { speaker_profiles: [], app_settings: [] };
    fakeHub = installFakeHub({ store });
  });

  function db(): AppDbBotClient {
    return new AppDbBotClient();
  }

  it('auto-enrols a coherent cluster (>=15s picked) that matches an existing profile', async () => {
    const profile = await profileStore.createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await profileStore.enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm0', durationSec: 10, source: 'auto-post', speakerKey: 'seed' });

    // A larger targetSec so BOTH 10s ranges are picked (>= the 15s auto-enrol duration bar) — planEnrolment stops greedily once its running total clears targetSec.
    env.speakerEnrolTargetSec = 30;
    const segments = [seg('spkA', 0, 10), seg('spkA', 12, 22)];
    for (const s of segments) rangeMarkers.set(`${s.startSec}:${s.endSec}`, VOICE_A);

    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1');
    expect(result.resolved).toBe(true);
    expect(result.profileId).toBe(profile.id);
    expect(result.confidence).toBeGreaterThan(0.99);
    expect(result.pendingEmbeddingJson).toBeUndefined();

    const reloaded = await profileStore.getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(2); // the pre-seeded one + the new auto-enrolment
  });

  it('names the speaker on a match but does NOT enrol a vector when the picked sample is shorter than the auto-enrol duration bar (15s)', async () => {
    const profile = await profileStore.createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    await profileStore.enrolEmbedding(db(), profile.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm0', durationSec: 10, source: 'auto-post', speakerKey: 'seed' });

    // Same short fixture as before phase-07: two 3s ranges = 6s picked, well under 15s.
    const segments = [seg('spkA', 0, 3), seg('spkA', 5, 8)];
    for (const s of segments) rangeMarkers.set(`${s.startSec}:${s.endSec}`, VOICE_A);

    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1');
    expect(result.resolved).toBe(true);
    expect(result.profileId).toBe(profile.id);
    expect(result.displayName).toBe('An');
    expect(result.pendingEmbeddingJson).toBeUndefined();

    const reloaded = await profileStore.getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1); // still just the pre-seeded vector — no auto-post vector added
  });

  it('does not auto-enrol below SPEAKER_AUTO_ENROL_THRESHOLD even though the (lower) match threshold is cleared and duration is long enough', async () => {
    const profile = await profileStore.createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    // A near-but-not-identical seed vector so the query's top-3-mean score lands between the two thresholds.
    await profileStore.enrolEmbedding(db(), profile.id, { vector: new Float32Array([0.75, 0.6614, 0, 0]), meetingId: 'm0', durationSec: 10, source: 'auto-post', speakerKey: 'seed' });
    env.speakerMatchThreshold = 0.5;
    env.speakerAutoEnrolThreshold = 0.9; // stricter than the match/naming bar
    env.speakerEnrolTargetSec = 30;

    const segments = [seg('spkA', 0, 10), seg('spkA', 12, 22)];
    for (const s of segments) rangeMarkers.set(`${s.startSec}:${s.endSec}`, VOICE_A); // query direction (1,0,0,0)

    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.confidence).toBeLessThan(0.9);
    expect(result.resolved).toBe(true);
    expect(result.profileId).toBe(profile.id); // still named

    const reloaded = await profileStore.getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1); // no vector added — below the auto-enrol bar
  });

  it('parks (does not name) a match whose margin over the runner-up profile is too small', async () => {
    const p1 = await profileStore.createProfile(db(), { displayName: 'An', createdByUserId: 'user-1' });
    const p2 = await profileStore.createProfile(db(), { displayName: 'Binh', createdByUserId: 'user-1' });
    // Both profiles score close to the query (A) — a genuinely ambiguous voice.
    await profileStore.enrolEmbedding(db(), p1.id, { vector: new Float32Array([1, 0, 0, 0]), meetingId: 'm0', durationSec: 10, source: 'auto-post', speakerKey: 'seed1' });
    await profileStore.enrolEmbedding(db(), p2.id, { vector: new Float32Array([0.99, 0.14, 0, 0]), meetingId: 'm0', durationSec: 10, source: 'auto-post', speakerKey: 'seed2' });
    env.speakerMatchMargin = 0.05;

    const segments = [seg('spkA', 0, 3), seg('spkA', 5, 8)];
    for (const s of segments) rangeMarkers.set(`${s.startSec}:${s.endSec}`, VOICE_A);

    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1');
    expect(result.resolved).toBe(false);
    expect(result.profileId).toBeUndefined();
    expect(result.pendingEmbeddingJson).toBeDefined(); // parked, not guessed wrong

    const reloadedP1 = await profileStore.getProfile(db(), p1.id);
    const reloadedP2 = await profileStore.getProfile(db(), p2.id);
    expect(reloadedP1?.embeddings).toHaveLength(1); // untouched
    expect(reloadedP2?.embeddings).toHaveLength(1); // untouched
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

  it('M2: a post-meeting user-post enrol replaces a prior one-shot user-live vector for the SAME person, never leaving two', async () => {
    const profile = await profileStore.createProfile(db(), { displayName: 'Binh', createdByUserId: 'owner-1', privosUserId: 'user-binh' });
    // Simulate the earlier live one-shot enrol — keyed by the LIVE sessionSpeakerId, not the async speakerId.
    await profileStore.enrolEmbedding(db(), profile.id, { vector: new Float32Array([0, 1, 0, 0]), meetingId: 'meeting-1', durationSec: 21, source: 'user-live', speakerKey: 'ss-1' });
    expect((await profileStore.getProfile(db(), profile.id))?.embeddings).toHaveLength(1);

    const segments = [seg('spkA', 0, 3), seg('spkA', 5, 8)];
    for (const s of segments) rangeMarkers.set(`${s.startSec}:${s.endSec}`, VOICE_A);

    // The job carries `sessionSpeakerId: 'ss-1'` on the identity — the same live speaker that already enrolled once.
    const userIdentityBySpeakerId = new Map([['spkA', { displayName: 'Binh', privosUserId: 'user-binh', createdByUserId: 'owner-1', sessionSpeakerId: 'ss-1' }]]);
    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1', userIdentityBySpeakerId);

    expect(result.resolved).toBe(true);
    expect(result.profileId).toBe(profile.id);

    const reloaded = await profileStore.getProfile(db(), profile.id);
    expect(reloaded?.embeddings).toHaveLength(1); // replaced the user-live vector — never two for one person in one meeting
  });

  it('reports "too little data" (no pendingEmbedding) when a speaker has no segment long/wordy enough to pick', async () => {
    const segments = [{ id: 's1', speakerId: 'spkShort', startSec: 0, endSec: 0.5, text: 'um', lang: 'vi', tokenCount: 1 }];
    const [result] = await resolveSpeakers(db(), '/fake/wav.wav', segments, 'meeting-1');
    expect(result.resolved).toBe(false);
    expect(result.sampleSec).toBe(0);
    expect(result.pendingEmbeddingJson).toBeUndefined();
  });
});

describe('readMatchThreshold (server-side floor clamp)', () => {
  beforeEach(() => {
    env.speakerMatchThreshold = 0.5;
    store = { speaker_profiles: [], app_settings: [] };
    fakeHub = installFakeHub({ store });
  });

  function db(): AppDbBotClient {
    return new AppDbBotClient();
  }

  it('clamps a stored app_settings value BELOW the floor up to the floor', async () => {
    await setSetting(db(), 'speakerMatchThreshold', 0.1); // a room member set it far too low
    expect(await readMatchThreshold(db())).toBe(0.35);
  });

  it('leaves a stored value ABOVE the floor unchanged', async () => {
    await setSetting(db(), 'speakerMatchThreshold', 0.6);
    expect(await readMatchThreshold(db())).toBe(0.6);
  });

  it('leaves the env default unchanged when nothing is stored (already above the floor)', async () => {
    expect(await readMatchThreshold(db())).toBe(0.5);
  });
});
