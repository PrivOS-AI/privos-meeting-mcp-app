import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

import { env } from '../env.js';
import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import { installFakeHub, type Store } from '../tools/test-support/fake-hub.js';
import { resetVoiceprintKeyCacheForTests } from '../speaker/voiceprint-crypto.js';
import { MeetingSessionRegistry, sessionRegistries } from '../speaker/session-speaker-registry.js';
import { ensureRegistry, loadForMeeting, upsertAll } from './live-speaker-repository.js';

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

function db(): AppDbBotClient {
  return new AppDbBotClient('room-1');
}

function seg(speaker: string, startMs: number, endMs = startMs + 3000) {
  return { speaker, startMs, endMs, final: true };
}

describe('live-speaker-repository', () => {
  beforeEach(() => {
    env.voiceprintEncKey = randomBytes(32).toString('base64');
    resetVoiceprintKeyCacheForTests();
    store = { meeting_speakers: [] };
    fakeHub = installFakeHub({ store });
  });

  it('upsertAll writes App DB only when the snapshot actually changed, sealing the centroid', async () => {
    const meetingId = `m-${Math.random()}`;
    const registry = new MeetingSessionRegistry(meetingId);
    registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 5, seg('s0:1', 0));

    await upsertAll(db(), meetingId, registry);
    expect(store.meeting_speakers).toHaveLength(1);
    const row = store.meeting_speakers[0];
    expect(row.sessionSpeakerId).toBe(registry.snapshot()[0].sessionSpeakerId);
    expect(typeof row.pendingEmbedding).toBe('string');
    expect(row.pendingEmbedding).not.toMatch(/^\[1,0,0,0\]$/); // sealed, not a raw vector dump

    // Same state, no new observation -> a second call is a no-op (S2-14).
    await upsertAll(db(), meetingId, registry);
    expect(store.meeting_speakers).toHaveLength(1);

    // A genuinely new observation -> writes again.
    registry.observe('s0:2', new Float32Array([0, 1, 0, 0]), 5, seg('s0:2', 10_000));
    await upsertAll(db(), meetingId, registry);
    expect(store.meeting_speakers).toHaveLength(2);
  });

  it('loadForMeeting decrypts centroids back into LoadableSpeakerRow[]', async () => {
    const meetingId = `m-${Math.random()}`;
    const registry = new MeetingSessionRegistry(meetingId);
    registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 5, seg('s0:1', 0));
    await upsertAll(db(), meetingId, registry);

    const rows = await loadForMeeting(db(), meetingId);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionSpeakerId).toBe(registry.snapshot()[0].sessionSpeakerId);
    expect(rows[0].centroid).toEqual(new Float32Array([1, 0, 0, 0]));
  });

  it('ensureRegistry rebuilds an evicted/restarted registry from meeting_speakers exactly once', async () => {
    const meetingId = `m-${Math.random()}`;
    const original = new MeetingSessionRegistry(meetingId);
    original.observe('s0:1', new Float32Array([1, 0, 0, 0]), 9, seg('s0:1', 0));
    original.observe('s0:1', new Float32Array([1, 0, 0, 0]), 1, seg('s0:1', 12_000)); // sticky
    await upsertAll(db(), meetingId, original);

    // Simulate a restart: nothing in the process-wide store for this meeting yet.
    const rebuilt = await ensureRegistry(db(), meetingId);
    expect(rebuilt.snapshot()).toHaveLength(1);
    expect(rebuilt.snapshot()[0].liveSpeechSec).toBeCloseTo(10);

    // A second call must NOT re-query/re-load — same in-memory instance.
    const again = await ensureRegistry(db(), meetingId);
    expect(again).toBe(rebuilt);
    expect(sessionRegistries.get(meetingId)).toBe(rebuilt);
  });

  it('upsertAll never downgrades a DB row already nameSource:user, even if the in-memory snapshot has not caught up (defense in depth)', async () => {
    const meetingId = `m-${Math.random()}`;
    const registry = new MeetingSessionRegistry(meetingId);
    registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 5, seg('s0:1', 0));
    const sessionSpeakerId = registry.snapshot()[0].sessionSpeakerId;
    await upsertAll(db(), meetingId, registry);

    // Simulate a DB row already confirmed by a human (e.g. written by `speaker_resolve` on another path)
    // while THIS registry's own in-memory copy is stale (never learned the identity) — the write below
    // must not clobber the confirmed name/profile back down to a guess.
    const row = store.meeting_speakers.find((r) => r.sessionSpeakerId === sessionSpeakerId)!;
    row.displayName = 'Thanh';
    row.nameSource = 'user';
    row.privosUserId = 'user-9';
    row.profileId = 'profile-9';
    row.resolved = true;

    registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 5, seg('s0:1', 20_000)); // new observation -> snapshot changes -> writes again
    await upsertAll(db(), meetingId, registry);

    const after = store.meeting_speakers.find((r) => r.sessionSpeakerId === sessionSpeakerId)!;
    expect(after.displayName).toBe('Thanh');
    expect(after.nameSource).toBe('user');
    expect(after.privosUserId).toBe('user-9');
    expect(after.profileId).toBe('profile-9');
    expect(after.resolved).toBe(true);
    // Live-only fields the registry DOES own are still refreshed.
    expect(after.liveSpeechSec).toBeCloseTo(10);
  });

  it('a merge survives a restart: upsertAll deletes the loser row, so loadFrom never reloads two overlapping speakers', async () => {
    const meetingId = `m-${Math.random()}`;
    const original = new MeetingSessionRegistry(meetingId);
    original.observe('s0:1', new Float32Array([1, 0, 0, 0]), 20, seg('s0:1', 0)); // A: speechSec=20
    original.observe('s1:2', new Float32Array([0, 1, 0, 0]), 5, seg('s1:2', 30_000)); // B: distinct, speechSec=5, brand new
    await upsertAll(db(), meetingId, original); // both rows persisted independently
    expect(store.meeting_speakers).toHaveLength(2);

    // B's centroid converges onto A's in two steps — each clears its own
    // per-turn fold-verify check (cos to B's best held vector: 0.8, then 0.6;
    // "verify non-sticky folds too" runs on every turn now, so a single big
    // jump straight from B's first turn would instead open a fresh instance).
    original.observe('s1:2', new Float32Array([0.6, 0.8, 0, 0]), 5, seg('s1:2', 36_000));
    original.observe('s1:2', new Float32Array([1, 0, 0, 0]), 5, seg('s1:2', 42_000)); // merges in-memory (default streak=1, no identity conflict)
    const active = original.snapshot().filter((s) => !s.mergedInto);
    expect(active).toHaveLength(1);
    const winnerId = active[0].sessionSpeakerId;

    await upsertAll(db(), meetingId, original);
    expect(store.meeting_speakers).toHaveLength(1); // the loser's row was deleted, not just left stale
    expect(store.meeting_speakers[0].sessionSpeakerId).toBe(winnerId);
    expect(store.meeting_speakers[0].liveSpeechSec).toBeCloseTo(35); // A(20) + B(5+5+5)

    // Simulate a restart: nothing in the process-wide store for this meeting yet.
    const rebuilt = await ensureRegistry(db(), meetingId);
    const rebuiltSnap = rebuilt.snapshot();
    expect(rebuiltSnap).toHaveLength(1); // never reloads as two overlapping speakers
    expect(rebuiltSnap[0].sonioxLabels.sort()).toEqual(['s0:1', 's1:2']);
    expect(rebuiltSnap[0].liveSpeechSec).toBeCloseTo(35);
  });

  it('merges field-by-field: a live write never clobbers fields it does not itself set', async () => {
    const meetingId = `m-${Math.random()}`;
    store.meeting_speakers.push({ _id: 'async-row', meeting: meetingId, speakerId: 'spkA', displayName: 'Async Name', totalSpeakSec: 30, nameSource: 'async' });

    const registry = new MeetingSessionRegistry(meetingId);
    registry.observe('s0:1', new Float32Array([1, 0, 0, 0]), 5, seg('s0:1', 0));
    await upsertAll(db(), meetingId, registry);

    const rows = extractDbRecords(await db().query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: meetingId }] }));
    const asyncRow = rows.find((r) => r.speakerId === 'spkA')!;
    expect(asyncRow.displayName).toBe('Async Name'); // untouched by the live write
    expect(asyncRow.totalSpeakSec).toBe(30);
    const liveRow = rows.find((r) => r.sessionSpeakerId);
    expect(liveRow?.displayName).toBeUndefined();
  });
});
