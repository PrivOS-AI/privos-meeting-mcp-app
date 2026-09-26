import { describe, expect, it } from 'vitest';
import type { McpApp } from '@privos_ai/app-react';

import {
  RecordingStore,
  resolveLineSpeakerKey,
  matchTurnsToLines,
  ownerForLabel,
  foldSpeakerMap,
  type CaptionLine,
  type LiveSpeakerBadge,
  type RecordingState,
} from './recording-store.js';
import type { LiveSpeaker, ServerTurn } from '../data/live-speaker-poll.js';

function fakeApp(callServerTool: McpApp['callServerTool']): McpApp {
  return { callServerTool } as unknown as McpApp;
}

function line(id: string, speakerKey: string, atSec: number, endSec: number): CaptionLine {
  return { id, text: 'x', atSec, endSec, isFinal: true, speakerKey };
}

describe('resolveLineSpeakerKey — resolution order', () => {
  it('prefers a per-line override over everything else', () => {
    const state = { lineSpeaker: { l1: 'manual:1' }, voiceAlias: { 's0:1': 'manual:2' }, lineServerSpeaker: { l1: 'ss-1' }, liveSpeakers: [] };
    expect(resolveLineSpeakerKey(state, line('l1', 's0:1', 0, 1))).toBe('manual:1');
  });

  it('prefers a whole-voice alias over server turn identity', () => {
    const state = { lineSpeaker: {}, voiceAlias: { 's0:1': 'manual:2' }, lineServerSpeaker: { l1: 'ss-1' }, liveSpeakers: [] };
    expect(resolveLineSpeakerKey(state, line('l1', 's0:1', 0, 1))).toBe('manual:2');
  });

  it('prefers the server turn identity over the raw realtime label', () => {
    const state = { lineSpeaker: {}, voiceAlias: {}, lineServerSpeaker: { l1: 'ss-1' }, liveSpeakers: [] };
    expect(resolveLineSpeakerKey(state, line('l1', 's0:1', 0, 1))).toBe('ss-1');
  });

  it('falls back to the realtime label before any turn has settled (the first ~60-90s)', () => {
    const state = { lineSpeaker: {}, voiceAlias: {}, lineServerSpeaker: {}, liveSpeakers: [] };
    expect(resolveLineSpeakerKey(state, line('l1', 's0:1', 0, 1))).toBe('s0:1');
  });

  it('follows a merged session speaker id to its winner instead of returning the stale loser id', () => {
    const speakers: LiveSpeaker[] = [
      { sessionSpeakerId: 'winner', sonioxLabels: ['s0:1'], colorKey: 'blue', resolved: true, liveSpeechSec: 10 },
      { sessionSpeakerId: 'loser', sonioxLabels: ['s0:1'], colorKey: 'gold', resolved: false, liveSpeechSec: 5, mergedInto: 'winner' },
    ];
    const state = { lineSpeaker: {}, voiceAlias: {}, lineServerSpeaker: { l1: 'loser' }, liveSpeakers: speakers };
    expect(resolveLineSpeakerKey(state, line('l1', 's0:1', 0, 1))).toBe('winner');
  });
});

describe('matchTurnsToLines — recycled label disambiguated by time, not label alone', () => {
  it('keeps earlier lines under speaker A and later lines under speaker B once the label recycles', () => {
    const lines: CaptionLine[] = [line('l1', 's0:1', 0, 5), line('l2', 's0:1', 5, 10), line('l3', 's0:1', 10, 15), line('l4', 's0:1', 15, 20)];
    const turns: ServerTurn[] = [
      { startMs: 0, endMs: 5000, label: 's0:1', sessionSpeakerId: 'A' },
      { startMs: 5000, endMs: 10000, label: 's0:1', sessionSpeakerId: 'A' },
      { startMs: 10000, endMs: 15000, label: 's0:1@2', sessionSpeakerId: 'B' }, // the reinstancing turn itself carries the suffixed label
      { startMs: 15000, endMs: 20000, label: 's0:1', sessionSpeakerId: 'B' }, // later turns settle back under the bare (recycled) label
    ];
    expect(matchTurnsToLines(lines, turns)).toEqual({ l1: 'A', l2: 'A', l3: 'B', l4: 'B' });
  });

  it('requires at least 50% overlap of the LINE\'s own timespan — a barely-touching turn does not match', () => {
    const lines: CaptionLine[] = [line('l1', 's0:1', 0, 10)];
    const turns: ServerTurn[] = [{ startMs: 9000, endMs: 12000, label: 's0:1', sessionSpeakerId: 'A' }]; // 1s of the line's 10s = 10%
    expect(matchTurnsToLines(lines, turns)).toEqual({});
  });

  it('never matches a turn against a line of a different base label', () => {
    const lines: CaptionLine[] = [line('l1', 's0:2', 0, 5)];
    const turns: ServerTurn[] = [{ startMs: 0, endMs: 5000, label: 's0:1', sessionSpeakerId: 'A' }];
    expect(matchTurnsToLines(lines, turns)).toEqual({});
  });
});

describe('ownerForLabel — majority-speech tie-break for a recycled label', () => {
  const speakers: LiveSpeaker[] = [
    { sessionSpeakerId: 'A', sonioxLabels: ['s0:1'], colorKey: 'blue', resolved: false, liveSpeechSec: 10 },
    { sessionSpeakerId: 'B', sonioxLabels: ['s0:1@2', 's0:1'], colorKey: 'gold', resolved: false, liveSpeechSec: 10 },
  ];

  it('resolves trivially when only one live speaker holds the label', () => {
    expect(ownerForLabel('s0:1', [speakers[0]], new Map())?.sessionSpeakerId).toBe('A');
  });

  it('picks the majority-speech holder when a label is currently held by two (recycled)', () => {
    const tally = new Map([['s0:1', new Map([['A', 5000], ['B', 15000]])]]);
    expect(ownerForLabel('s0:1', speakers, tally)?.sessionSpeakerId).toBe('B');
  });

  it('falls back to the first-listed candidate when there is no speech tally for the label yet', () => {
    expect(ownerForLabel('s0:1', speakers, new Map())?.sessionSpeakerId).toBe('A');
  });

  it('returns undefined when no live session speaker has claimed the label at all', () => {
    expect(ownerForLabel('s0:9', speakers, new Map())).toBeUndefined();
  });
});

describe('foldSpeakerMap — one chip per session speaker, label chips fold into it', () => {
  it('folds a realtime-label chip into its owning session speaker, carrying name/colour/resolved over', () => {
    const speakerMap: Record<string, LiveSpeakerBadge> = { 's0:1': { displayName: 'Alice', colorKey: 'blue', resolved: true } };
    const speakers: LiveSpeaker[] = [{ sessionSpeakerId: 'ss-1', sonioxLabels: ['s0:1'], colorKey: 'blue', resolved: false, liveSpeechSec: 10 }];
    const next = foldSpeakerMap(speakerMap, speakers, new Map());
    expect(next['s0:1']).toBeUndefined();
    expect(next['ss-1']).toMatchObject({ displayName: 'Alice', colorKey: 'blue' });
  });

  it('leaves a label chip untouched when no live session speaker has claimed it yet', () => {
    const speakerMap: Record<string, LiveSpeakerBadge> = { 's0:1': { colorKey: 'blue', resolved: false } };
    expect(foldSpeakerMap(speakerMap, [], new Map())['s0:1']).toEqual({ colorKey: 'blue', resolved: false });
  });

  it('the server-confirmed displayName wins over whatever the folded label chip locally guessed', () => {
    const speakerMap: Record<string, LiveSpeakerBadge> = { 's0:1': { displayName: 'Guessed', colorKey: 'blue', resolved: false } };
    const speakers: LiveSpeaker[] = [
      { sessionSpeakerId: 'ss-1', sonioxLabels: ['s0:1'], displayName: 'Confirmed', colorKey: 'blue', resolved: true, liveSpeechSec: 10 },
    ];
    expect(foldSpeakerMap(speakerMap, speakers, new Map())['ss-1'].displayName).toBe('Confirmed');
  });

  it('a recycled label folds into its majority-speech owner only — the other session speaker stays unnamed', () => {
    const speakerMap: Record<string, LiveSpeakerBadge> = { 's0:1': { displayName: 'Alice', colorKey: 'blue', resolved: true } };
    const speakers: LiveSpeaker[] = [
      { sessionSpeakerId: 'A', sonioxLabels: ['s0:1'], colorKey: 'blue', resolved: false, liveSpeechSec: 10 },
      { sessionSpeakerId: 'B', sonioxLabels: ['s0:1@2', 's0:1'], colorKey: 'gold', resolved: false, liveSpeechSec: 10 },
    ];
    const tally = new Map([['s0:1', new Map([['A', 5000], ['B', 15000]])]]);
    const next = foldSpeakerMap(speakerMap, speakers, tally);
    expect(next['A'].displayName).toBeUndefined();
    expect(next['B'].displayName).toBe('Alice');
  });
});

/** White-box access to the private poll-driven glue (`applyPollUpdate`) and `state` — there is no lighter public seam to drive a simulated poll without the full `startRecording()` flow (mic/Hub calls), so tests reach past `private` deliberately here. */
interface StoreInternals {
  state: RecordingState;
  applyPollUpdate(speakers: LiveSpeaker[], turns: ServerTurn[], meta: { degraded: boolean; labelsSupported: boolean }): void;
}

function internals(store: RecordingStore): StoreInternals {
  return store as unknown as StoreInternals;
}

function makeStore(callServerTool: McpApp['callServerTool']): RecordingStore {
  const store = new RecordingStore(fakeApp(callServerTool), { roomId: 'room-1', userId: 'user-1', username: 'Alice' });
  internals(store).state = { ...store.getState(), meetingId: 'meeting-1' };
  return store;
}

describe('RecordingStore — manual naming survives the hand-over from label chip to session-speaker chip', () => {
  it('naming a realtime label at second one still resolves once its session speaker forms on the next poll', async () => {
    const resolveCalls: Record<string, unknown>[] = [];
    const store = makeStore(async (params) => {
      expect(params.name).toBe('speaker_resolve');
      resolveCalls.push(params.arguments as Record<string, unknown>);
      return { resolved: [{ speakerId: 'ss-1', enrolled: false, displayName: 'Alice' }] };
    });

    store.assignRealtimeSpeaker('s0:1', { mode: 'name', displayName: 'Alice' });
    expect(store.getState().speakerMap['s0:1']?.displayName).toBe('Alice'); // optimistic, immediate

    internals(store).applyPollUpdate(
      [{ sessionSpeakerId: 'ss-1', sonioxLabels: ['s0:1'], colorKey: 'blue', resolved: false, liveSpeechSec: 5 }],
      [{ startMs: 0, endMs: 5000, label: 's0:1', sessionSpeakerId: 'ss-1' }],
      { degraded: false, labelsSupported: true },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]).toMatchObject({ assignments: [{ speakerId: 'ss-1', mode: 'name', displayName: 'Alice' }] });
    expect(store.getState().speakerMap['s0:1']).toBeUndefined(); // folded away
    expect(store.getState().speakerMap['ss-1']?.displayName).toBe('Alice'); // survives the hand-over
  });

  it('a recycled label names only the session speaker holding the majority of its speech at assignment time', async () => {
    const resolveCalls: Record<string, unknown>[] = [];
    const store = makeStore(async (params) => {
      const args = params.arguments as { assignments: Array<{ speakerId: string; displayName?: string }> };
      resolveCalls.push(args);
      return { resolved: [{ speakerId: args.assignments[0].speakerId, enrolled: false, displayName: args.assignments[0].displayName }] };
    });

    // Two session speakers already share the recycled label "s0:1" by the time the poll lands.
    internals(store).applyPollUpdate(
      [
        { sessionSpeakerId: 'A', sonioxLabels: ['s0:1'], colorKey: 'blue', resolved: false, liveSpeechSec: 5 },
        { sessionSpeakerId: 'B', sonioxLabels: ['s0:1@2', 's0:1'], colorKey: 'gold', resolved: false, liveSpeechSec: 15 },
      ],
      [
        { startMs: 0, endMs: 5000, label: 's0:1', sessionSpeakerId: 'A' },
        { startMs: 10000, endMs: 25000, label: 's0:1', sessionSpeakerId: 'B' },
      ],
      { degraded: false, labelsSupported: true },
    );

    store.assignRealtimeSpeaker('s0:1', { mode: 'name', displayName: 'Alice' });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]).toMatchObject({ assignments: [{ speakerId: 'B', displayName: 'Alice' }] }); // B has 15s of that label vs A's 5s
  });

  it('renaming an already-folded session-speaker chip persists it and is not overwritten by the server voiceprint guess', async () => {
    const resolveCalls: Array<{ assignments: Array<{ speakerId: string; displayName?: string }> }> = [];
    let resolveResult: unknown = { resolved: [{ speakerId: 'ss-1', reason: 'not_found' }] };
    const store = makeStore(async (params) => {
      resolveCalls.push(params.arguments as (typeof resolveCalls)[number]);
      return resolveResult;
    });
    const guessed = [{ sessionSpeakerId: 'ss-1', sonioxLabels: ['s0:1'], displayName: 'Bob', colorKey: 'blue', resolved: true, liveSpeechSec: 20 }];
    internals(store).applyPollUpdate(guessed, [], { degraded: false, labelsSupported: true });

    store.assignRealtimeSpeaker('ss-1', { mode: 'name', displayName: 'Alice' }); // the line's effective key is the session speaker
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveCalls[0]).toMatchObject({ assignments: [{ speakerId: 'ss-1', displayName: 'Alice' }] });

    // Still pending (not_found) — the next poll's server guess must not clobber the user's name.
    internals(store).applyPollUpdate(guessed, [], { degraded: false, labelsSupported: true });
    expect(store.getState().speakerMap['ss-1']?.displayName).toBe('Alice');
  });

  it('naming a local manual speaker never calls speaker_resolve', async () => {
    const store = makeStore(async () => {
      throw new Error('unexpected server call');
    });
    const key = store.addManualSpeaker();
    store.assignRealtimeSpeaker(key, { mode: 'name', displayName: 'Carol' });
    await Promise.resolve();
    expect(store.getState().speakerMap[key]?.displayName).toBe('Carol');
  });
});

describe('RecordingStore — bookmark toggle + side-panel removal keep bookmarkedSecs in sync', () => {
  interface DbCall {
    name: string;
    arguments: Record<string, unknown>;
  }

  /** Routes mcpapp.db.* create/delete/query for the bookmark flow. */
  function bookmarkStore(): { store: RecordingStore; calls: DbCall[]; queryResult: () => { records: Array<Record<string, unknown>>; total: number } } {
    const calls: DbCall[] = [];
    let created = 0;
    let queryRecords: Array<Record<string, unknown>> = [];
    const store = makeStore(async (params) => {
      const call = params as DbCall;
      calls.push(call);
      if (call.name === 'mcpapp.db.create') return { _id: `bm-${++created}` };
      if (call.name === 'mcpapp.db.delete') return null;
      if (call.name === 'mcpapp.db.query') return { records: queryRecords, total: queryRecords.length };
      return null;
    });
    return {
      store,
      calls,
      queryResult: () => ({ records: queryRecords, total: queryRecords.length }),
    };
  }

  it('adds a bookmark, records its id, and is idempotent for the same second', async () => {
    const { store, calls } = bookmarkStore();
    await store.addBookmark(12, 'hello there');
    await store.addBookmark(12, 'hello there'); // same segment — no-op

    expect(store.getState().bookmarkedSecs).toEqual([12]);
    expect(store.getState().bookmarkIdsBySec).toEqual({ 12: 'bm-1' });
    expect(store.getState().bookmarkRev).toBe(1);
    expect(calls.filter((c) => c.name === 'mcpapp.db.create')).toHaveLength(1);
  });

  it('a second tap removes the bookmark via the tracked id and clears the segment', async () => {
    const { store, calls } = bookmarkStore();
    await store.addBookmark(30, 'x');
    await store.removeBookmark(30);

    const del = calls.find((c) => c.name === 'mcpapp.db.delete');
    expect(del?.arguments).toEqual({ collection: 'bookmarks', id: 'bm-1' });
    expect(store.getState().bookmarkedSecs).toEqual([]);
    expect(store.getState().bookmarkIdsBySec).toEqual({});
    expect(store.getState().bookmarkRev).toBe(2);
    expect(calls.some((c) => c.name === 'mcpapp.db.query')).toBe(false); // id was tracked — no lookup needed
  });

  it('removal falls back to a lookup when the id was not tracked this session', async () => {
    const calls: DbCall[] = [];
    const store = makeStore(async (params) => {
      const call = params as DbCall;
      calls.push(call);
      if (call.name === 'mcpapp.db.query') return { records: [{ _id: 'bm-old', meeting: 'meeting-1', atSec: 42 }], total: 1 };
      return null;
    });
    // Simulate a bookmark present in state (e.g. resumed session) with no id map entry.
    internals(store).state = { ...store.getState(), bookmarkedSecs: [42], bookmarkIdsBySec: {} };

    await store.removeBookmark(42);

    expect(calls.some((c) => c.name === 'mcpapp.db.query')).toBe(true);
    const del = calls.find((c) => c.name === 'mcpapp.db.delete');
    expect(del?.arguments).toEqual({ collection: 'bookmarks', id: 'bm-old' });
    expect(store.getState().bookmarkedSecs).toEqual([]);
  });
});
