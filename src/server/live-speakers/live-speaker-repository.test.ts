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
