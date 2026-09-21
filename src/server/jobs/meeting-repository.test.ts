import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import { installFakeHub, type Store } from '../tools/test-support/fake-hub.js';
import { deleteUnmappedLiveSpeakers, loadLiveIdentities, mergeLiveIntoAsyncSpeaker, replaceActionItems } from './meeting-repository.js';

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

function db(): AppDbBotClient {
  return new AppDbBotClient('room-1');
}

describe('mergeLiveIntoAsyncSpeaker', () => {
  beforeEach(() => {
    store = { meeting_speakers: [] };
    fakeHub = installFakeHub({ store });
  });

  it('folds the live row into the async row and deletes the standalone live row', async () => {
    store.meeting_speakers.push(
      { _id: 'async-1', meeting: 'm1', speakerId: 'spkA', displayName: 'Speaker 1', nameSource: 'async', resolved: false },
      { _id: 'live-1', meeting: 'm1', sessionSpeakerId: 'ss-1', sonioxLabels: ['s0:1'], liveSpeechSec: 12, liveConfidence: 0.7, nameSource: 'live', displayName: 'Some Name', resolved: true },
    );

    await mergeLiveIntoAsyncSpeaker(db(), 'm1', 'spkA', 'ss-1');

    const rows = extractDbRecords(await db().query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: 'm1' }] }));
    expect(rows).toHaveLength(1);
    const merged = rows[0];
    expect(merged.speakerId).toBe('spkA');
    expect(merged.sessionSpeakerId).toBe('ss-1');
    expect(merged.sonioxLabels).toEqual(['s0:1']);
    expect(merged.liveSpeechSec).toBe(12);
    // live (rank 1) does NOT outrank async's already-set name source (rank 2) — async keeps its own placeholder name.
    expect(merged.displayName).toBe('Speaker 1');
    expect(merged.nameSource).toBe('async');
  });

  it("adopts the live row's user-confirmed name when the async row is still unresolved", async () => {
    store.meeting_speakers.push(
      { _id: 'async-1', meeting: 'm1', speakerId: 'spkA', displayName: 'Speaker 1', nameSource: undefined, resolved: false },
      { _id: 'live-1', meeting: 'm1', sessionSpeakerId: 'ss-1', displayName: 'Thanh', nameSource: 'user', profileId: 'profile-9', resolved: true },
    );

    await mergeLiveIntoAsyncSpeaker(db(), 'm1', 'spkA', 'ss-1');

    const rows = extractDbRecords(await db().query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: 'm1' }] }));
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe('Thanh');
    expect(rows[0].nameSource).toBe('user');
    expect(rows[0].profileId).toBe('profile-9');
    expect(rows[0].resolved).toBe(true);
  });

  it('is a no-op when there is no matching async row', async () => {
    store.meeting_speakers.push({ _id: 'live-1', meeting: 'm1', sessionSpeakerId: 'ss-1' });
    await mergeLiveIntoAsyncSpeaker(db(), 'm1', 'spkMissing', 'ss-1');
    expect(store.meeting_speakers).toHaveLength(1); // untouched
  });
});

describe('deleteUnmappedLiveSpeakers', () => {
  beforeEach(() => {
    store = { meeting_speakers: [] };
    fakeHub = installFakeHub({ store });
  });

  it('deletes live-only rows that never mapped to an async speaker, keeps mapped/async rows', async () => {
    store.meeting_speakers.push(
      { _id: 'async-1', meeting: 'm1', speakerId: 'spkA', sessionSpeakerId: 'ss-mapped' },
      { _id: 'live-mapped', meeting: 'm1', sessionSpeakerId: 'ss-mapped' },
      { _id: 'live-orphan', meeting: 'm1', sessionSpeakerId: 'ss-orphan' },
    );

    await deleteUnmappedLiveSpeakers(db(), 'm1', new Set(['ss-mapped']));

    const rows = extractDbRecords(await db().query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: 'm1' }] }));
    expect(rows.map((r) => r._id).sort()).toEqual(['async-1', 'live-mapped']);
  });

  it('(f) a user-named live speaker with NO async mapping survives the job — never deleted even though unmapped', async () => {
    store.meeting_speakers.push(
      { _id: 'live-user', meeting: 'm1', sessionSpeakerId: 'ss-user', nameSource: 'user', displayName: 'Thanh', resolved: true },
      { _id: 'live-guess', meeting: 'm1', sessionSpeakerId: 'ss-guess', nameSource: 'live', displayName: 'Speaker 2' },
    );

    await deleteUnmappedLiveSpeakers(db(), 'm1', new Set()); // neither mapped to any async speaker

    const rows = extractDbRecords(await db().query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: 'm1' }] }));
    expect(rows.map((r) => r._id)).toEqual(['live-user']); // the unnamed guess is noise and is deleted; the user-named row survives
  });
});

describe('loadLiveIdentities', () => {
  beforeEach(() => {
    store = { meeting_speakers: [] };
    fakeHub = installFakeHub({ store });
  });

  it('reads identity fields keyed by sessionSpeakerId, skipping rows without one', async () => {
    store.meeting_speakers.push(
      { _id: 'live-1', meeting: 'm1', sessionSpeakerId: 'ss-1', nameSource: 'user', displayName: 'Thanh', privosUserId: 'user-9', profileId: 'profile-9' },
      { _id: 'async-1', meeting: 'm1', speakerId: 'spkA' }, // no sessionSpeakerId yet — skipped
    );

    const identities = await loadLiveIdentities(db(), 'm1');
    expect(identities.size).toBe(1);
    expect(identities.get('ss-1')).toEqual({ displayName: 'Thanh', privosUserId: 'user-9', profileId: 'profile-9', nameSource: 'user' });
  });
});

describe('replaceActionItems', () => {
  beforeEach(() => {
    store = { action_items: [] };
    fakeHub = installFakeHub({ store });
  });

  it('creates the given items for a meeting with no prior action_items', async () => {
    await replaceActionItems(db(), 'm1', [{ task: 'Write documentation', owner: 'Thanh', due: '2026-09-25T00:00:00.000Z', atSec: 12 }]);
    const rows = extractDbRecords(await db().query('action_items', 'room', { where: [{ field: 'meeting', op: '==', value: 'm1' }] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ meeting: 'm1', task: 'Write documentation', owner: 'Thanh', done: false });
  });

  it('re-running with the same items does not duplicate rows (deletes stale rows first)', async () => {
    await replaceActionItems(db(), 'm1', [{ task: 'A' }, { task: 'B' }]);
    await replaceActionItems(db(), 'm1', [{ task: 'A' }, { task: 'B' }]);
    const rows = extractDbRecords(await db().query('action_items', 'room', { where: [{ field: 'meeting', op: '==', value: 'm1' }] }));
    expect(rows).toHaveLength(2);
  });

  it('drops items from a previous run that are no longer present', async () => {
    await replaceActionItems(db(), 'm1', [{ task: 'A' }, { task: 'B' }]);
    await replaceActionItems(db(), 'm1', [{ task: 'A' }]);
    const rows = extractDbRecords(await db().query('action_items', 'room', { where: [{ field: 'meeting', op: '==', value: 'm1' }] }));
    expect(rows.map((r) => r.task)).toEqual(['A']);
  });

  it('never touches another meeting\'s action_items', async () => {
    await replaceActionItems(db(), 'm1', [{ task: 'A' }]);
    store.action_items.push({ _id: 'other-1', meeting: 'm2', task: 'Other meeting task', done: false });
    await replaceActionItems(db(), 'm1', [{ task: 'A2' }]);
    const other = extractDbRecords(await db().query('action_items', 'room', { where: [{ field: 'meeting', op: '==', value: 'm2' }] }));
    expect(other).toHaveLength(1);
  });
});
