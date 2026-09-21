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
import { sessionRegistries } from '../speaker/session-speaker-registry.js';
import { upsertAll } from '../live-speakers/live-speaker-repository.js';
import { getChunkQueueForTests } from '../live-speakers/chunk-worker.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
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

function db(): AppDbBotClient {
  return new AppDbBotClient('room-1');
}

function seg(speaker: string, startMs: number, endMs = startMs + 3000) {
  return { speaker, startMs, endMs, final: true };
}

/**
 * Builds a LIVE `meeting_speakers` row via the REAL registry + `upsertAll`
 * pipeline (never a hand-built `sealPendingEmbedding` call) — the exact gap
 * root cause 2 called out: a test fixture divorced from what production
 * actually writes. Uses `sessionRegistries.get` (not `new
 * MeetingSessionRegistry`) so the SAME in-process registry the tool itself
 * looks up is the one seeded here.
 */
async function seedLiveRow(meetingId: string, turns: readonly { vector: Float32Array; durSec: number }[]): Promise<string> {
  sessionRegistries.delete(meetingId); // isolate from any earlier test that touched this meetingId
  const registry = sessionRegistries.get(meetingId);
  turns.forEach((turn, i) => registry.observe('s0:1', turn.vector, turn.durSec, seg('s0:1', i * 10_000)));
  await upsertAll(db(), meetingId, registry);
  return registry.snapshot()[0].sessionSpeakerId;
}

describe('speaker_resolve', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    env.speakerMatchThreshold = 0.5;
    env.liveEnrolMinSpeechSec = 20;
    env.speakerLiveEnrolCoherence = 0.5;
    resetVoiceprintKeyCacheForTests();
    store = {
      meetings: [
        { _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'owner-1' },
        { _id: 'meeting-2', roomId: 'room-1', ownerUserId: 'owner-1' },
      ],
      meeting_speakers: [{ _id: 'ms1', meeting: 'meeting-1', speakerId: 'spk1', resolved: false, pendingEmbedding: coherentPending() }],
      speaker_profiles: [],
      app_settings: [],
    };
    fakeHub = installFakeHub({ store });
    sessionRegistries.delete('meeting-1');
    sessionRegistries.delete('meeting-2');
  });

  it('rejects a non-owner', async () => {
    await expect(
      speakerResolveTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'skip' }] }, ctx('someone-else'), {} as never),
    ).rejects.toThrow(/meeting owner/);
  });

  it('mode "name" creates a new profile and enrols when the cluster is coherent', async () => {
    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'name', displayName: 'Alex Smith' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ speakerId: string; enrolled: boolean; profileId?: string }> };

    expect(result.resolved[0].enrolled).toBe(true);
    expect(store.speaker_profiles).toHaveLength(1);
    expect(store.speaker_profiles[0].displayName).toBe('Alex Smith');
    expect(store.meeting_speakers[0].resolved).toBe(true);
  });

  it('mode "name" sets the display name but does NOT enrol when the cluster is incoherent (bimodal)', async () => {
    store.meeting_speakers[0].pendingEmbedding = incoherentPending();
    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'name', displayName: 'Two-person group' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ enrolled: boolean; reason?: string }> };

    expect(result.resolved[0].enrolled).toBe(false);
    expect(result.resolved[0].reason).toBe('cluster_not_coherent');
    expect(store.speaker_profiles).toHaveLength(0);
    expect(store.meeting_speakers[0].displayName).toBe('Two-person group');
  });

  it('mode "user" is rejected per-assignment when the cluster is incoherent', async () => {
    store.meeting_speakers[0].pendingEmbedding = incoherentPending();
    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'user', privosUserId: 'user-42' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ enrolled: boolean; reason?: string; displayName?: string }> };

    // CHANGED CONTRACT (this phase): the member identity is persisted even when enrolment is deferred,
    // so the response now also carries the displayName the row was given — previously mode 'user'/'merge'
    // wrote and returned nothing at all on an incoherent cluster.
    expect(result.resolved[0]).toEqual({ speakerId: 'spk1', enrolled: false, reason: 'cluster_not_coherent', displayName: 'User user-4' });
    expect(store.speaker_profiles).toHaveLength(0);
    expect(store.meeting_speakers[0].displayName).toBe('User user-4');
    expect(store.meeting_speakers[0].privosUserId).toBe('user-42');
    expect(store.meeting_speakers[0].nameSource).toBe('user');
    expect(store.meeting_speakers[0].resolved).toBe(true);
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
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'name', displayName: 'Other' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ enrolled: boolean; reason?: string; profileId?: string }> };
    expect(result.resolved[0]).toEqual({ speakerId: 'spk1', enrolled: true, profileId: 'profile-y', reason: 'already_resolved' });
  });

  it('never clears pendingEmbedding on the row (kept until the async job clears it, not at resolve time)', async () => {
    await speakerResolveTool.execute({ roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spk1', mode: 'name', displayName: 'An' }] }, ctx(), {} as never);
    expect(store.meeting_speakers[0].pendingEmbedding).toBeTruthy();
  });

  it('P5 quick-assign: accepts a sessionSpeakerId as speakerId when no async speakerId row matches, and enrols once the live bar is met (mid-meeting live registry row)', async () => {
    // (d) live bar met (speechSec>=20, rangeCount>=3, coherence>=SPEAKER_LIVE_ENROL_COHERENCE) -> `user-live` enrol.
    const sessionSpeakerId = await seedLiveRow('meeting-2', [
      { vector: new Float32Array([0, 1, 0, 0]), durSec: 7 },
      { vector: new Float32Array([0, 1, 0, 0]), durSec: 7 },
      { vector: new Float32Array([0, 1, 0, 0]), durSec: 7 },
    ]);

    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-2', assignments: [{ speakerId: sessionSpeakerId, mode: 'name', displayName: 'Thanh' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ speakerId: string; enrolled: boolean; displayName?: string; profileId?: string }> };

    expect(result.resolved[0]).toMatchObject({ speakerId: sessionSpeakerId, enrolled: true, displayName: 'Thanh' });
    const liveRow = store.meeting_speakers.find((r) => r.sessionSpeakerId === sessionSpeakerId)!;
    expect(liveRow.displayName).toBe('Thanh');
    expect(liveRow.resolved).toBe(true);
    expect(liveRow.nameSource).toBe('user');
    expect(store.speaker_profiles.find((p) => p._id === result.resolved[0].profileId)?.displayName).toBe('Thanh');
  });

  it('(h) mode "user" on a 1-turn live row: named + privosUserId persisted, enrol_deferred, no vector created', async () => {
    const sessionSpeakerId = await seedLiveRow('meeting-2', [{ vector: new Float32Array([0, 1, 0, 0]), durSec: 9 }]);

    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-2', assignments: [{ speakerId: sessionSpeakerId, mode: 'user', privosUserId: 'user-42', displayName: 'Thanh' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ speakerId: string; enrolled: boolean; displayName?: string; reason?: string }> };

    expect(result.resolved[0]).toMatchObject({ speakerId: sessionSpeakerId, enrolled: false, displayName: 'Thanh', reason: 'enrol_deferred' });
    expect(store.speaker_profiles).toHaveLength(0);
    const liveRow = store.meeting_speakers.find((r) => r.sessionSpeakerId === sessionSpeakerId)!;
    expect(liveRow.displayName).toBe('Thanh');
    expect(liveRow.privosUserId).toBe('user-42');
    expect(liveRow.nameSource).toBe('user');
    expect(liveRow.resolved).toBe(true);
    expect(liveRow.profileId).toBeFalsy();
  });

  it('(b) mode "user" with no pending embedding at all still persists the member identity', async () => {
    store.meeting_speakers.push({ _id: 'ms-nopending', meeting: 'meeting-1', speakerId: 'spkNoPending', resolved: false });

    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-1', assignments: [{ speakerId: 'spkNoPending', mode: 'user', privosUserId: 'user-7', displayName: 'Binh' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ enrolled: boolean; displayName?: string; reason?: string }> };

    expect(result.resolved[0]).toMatchObject({ enrolled: false, displayName: 'Binh', reason: 'no_pending_embedding' });
    const row = store.meeting_speakers.find((r) => r.speakerId === 'spkNoPending')!;
    expect(row.displayName).toBe('Binh');
    expect(row.privosUserId).toBe('user-7');
    expect(row.nameSource).toBe('user');
    expect(row.resolved).toBe(true);
  });

  it('(g) an envelope copied onto a different row is rejected (profileId binding)', async () => {
    const ssA = await seedLiveRow('meeting-2', [{ vector: new Float32Array([1, 0, 0, 0]), durSec: 7 }]);
    const registry = sessionRegistries.get('meeting-2');
    registry.observe('s0:2', new Float32Array([0, 0, 1, 0]), 7, seg('s0:2', 100_000));
    await upsertAll(db(), 'meeting-2', registry);
    const ssB = registry.snapshot().find((s) => s.sessionSpeakerId !== ssA)!.sessionSpeakerId;

    const rowA = store.meeting_speakers.find((r) => r.sessionSpeakerId === ssA)!;
    const rowB = store.meeting_speakers.find((r) => r.sessionSpeakerId === ssB)!;
    rowB.pendingEmbedding = rowA.pendingEmbedding; // copy A's sealed envelope onto B's row

    const result = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-2', assignments: [{ speakerId: ssB, mode: 'name', displayName: 'Copied' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ enrolled: boolean; reason?: string }> };

    // The binding check (embedded profileId must equal live:meeting-2:ssB) rejects the copied envelope outright —
    // treated the same as "no envelope at all" for a live row (`enrol_deferred`), never silently enrolling A's voice under B's name.
    expect(result.resolved[0]).toMatchObject({ enrolled: false, reason: 'enrol_deferred', displayName: 'Copied' });
    expect(store.speaker_profiles).toHaveLength(0);
  });

  it('(a) registry -> upsertAll -> speaker_resolve "name" -> another upsertAll: the row stays nameSource:user, resolved:true', async () => {
    const sessionSpeakerId = await seedLiveRow('meeting-2', [
      { vector: new Float32Array([1, 0, 0, 0]), durSec: 7 },
      { vector: new Float32Array([1, 0, 0, 0]), durSec: 7 },
      { vector: new Float32Array([1, 0, 0, 0]), durSec: 7 },
    ]);

    await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-2', assignments: [{ speakerId: sessionSpeakerId, mode: 'name', displayName: 'Thanh' }] },
      ctx(),
      {} as never,
    );

    // Another chunk lands afterwards — the registry keeps folding new turns and `upsertAll` runs again.
    const registry = sessionRegistries.get('meeting-2');
    registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 5, seg('s0:1', 500_000));
    await upsertAll(db(), 'meeting-2', registry);

    const row = store.meeting_speakers.find((r) => r.sessionSpeakerId === sessionSpeakerId)!;
    expect(row.nameSource).toBe('user');
    expect(row.resolved).toBe(true);
    expect(row.displayName).toBe('Thanh');
  });

  it('(i) a repeated resolve on a named-but-unenrolled row REPLACES its vector, never appends a second one', async () => {
    const sessionSpeakerId = await seedLiveRow('meeting-2', [
      { vector: new Float32Array([1, 0, 0, 0]), durSec: 7 },
      { vector: new Float32Array([1, 0, 0, 0]), durSec: 7 },
      { vector: new Float32Array([1, 0, 0, 0]), durSec: 7 },
    ]);

    const first = (await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-2', assignments: [{ speakerId: sessionSpeakerId, mode: 'name', displayName: 'Thanh' }] },
      ctx(),
      {} as never,
    )) as { resolved: Array<{ profileId?: string }> };
    const profileId = first.resolved[0].profileId!;
    expect(store.speaker_profiles.find((p) => p._id === profileId)?.embeddings).toHaveLength(1);

    // Row is resolved:true but has a profileId already -> `already_resolved` short-circuits a second identical call;
    // simulate the row falling back to "named but unenrolled" (clear profileId) to exercise the replace-not-append path.
    const row = store.meeting_speakers.find((r) => r.sessionSpeakerId === sessionSpeakerId)!;
    row.profileId = undefined;

    await speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-2', assignments: [{ speakerId: sessionSpeakerId, mode: 'name', displayName: 'Thanh' }] },
      ctx(),
      {} as never,
    );

    expect(store.speaker_profiles.find((p) => p._id === profileId)?.embeddings).toHaveLength(1); // replaced, not appended
  });

  it('(e) an assignment is queued behind an in-flight chunk task for the same meeting — never interleaved', async () => {
    const sessionSpeakerId = await seedLiveRow('meeting-2', [{ vector: new Float32Array([1, 0, 0, 0]), durSec: 7 }]);
    const queue = getChunkQueueForTests();

    const order: string[] = [];
    let releaseSlowTask!: () => void;
    const slowTaskGate = new Promise<void>((resolve) => {
      releaseSlowTask = resolve;
    });
    // Occupies the SAME per-meeting queue slot `speaker_resolve` uses — proves the tool's work is queued behind it, not run concurrently.
    const slowTaskDone = queue.enqueue('meeting-2', { kind: 'task' }, async () => {
      order.push('slow-start');
      await slowTaskGate;
      order.push('slow-end');
    });

    const resolvePromise = speakerResolveTool.execute(
      { roomId: 'room-1', meetingId: 'meeting-2', assignments: [{ speakerId: sessionSpeakerId, mode: 'name', displayName: 'Thanh' }] },
      ctx(),
      {} as never,
    ).then((r) => {
      order.push('resolve-done');
      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 0)); // let the slow task actually start first
    expect(order).toEqual(['slow-start']);
    releaseSlowTask();
    await slowTaskDone;
    await resolvePromise;

    expect(order).toEqual(['slow-start', 'slow-end', 'resolve-done']);
    const row = store.meeting_speakers.find((r) => r.sessionSpeakerId === sessionSpeakerId)!;
    expect(row.displayName).toBe('Thanh');
    expect(row.nameSource).toBe('user');
  });
});
