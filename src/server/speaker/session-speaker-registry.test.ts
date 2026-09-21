import { describe, expect, it } from 'vitest';

import { env } from '../env.js';
import { MeetingSessionRegistry, SessionRegistryStore, type SpeakerRegistryFact } from './session-speaker-registry.js';

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

function seg(speaker: string, startMs: number, endMs = startMs + 3000, final = true) {
  return { speaker, startMs, endMs, final };
}

describe('MeetingSessionRegistry', () => {
  it('(a) a stable label stays bound to one session speaker across turns', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 3, seg('s0:1', 0));
    reg.observe('s0:1', vec(0.95, 0.31), 3, seg('s0:1', 4000));
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].sonioxLabels).toEqual(['s0:1']);
    expect(snap[0].liveSpeechSec).toBeCloseTo(6);
  });

  it('(b) the provider renaming a label for the SAME voice attaches the new label to the same session speaker', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0));
    // Different label, near-identical embedding -> matches the existing session speaker via centroid, not label.
    reg.observe('s0:3', vec(0.99, 0.14), 5, seg('s0:3', 8000));
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].sonioxLabels.sort()).toEqual(['s0:1', 's0:3']);
  });

  it('(c) a label reused for a DIFFERENT voice opens label@2 and leaves the original centroid untouched', () => {
    const reg = new MeetingSessionRegistry('m1');
    // Two turns to make "s0:1" sticky (turnCount>=2, speechSec>=LIVE_MIN_SPEECH_SEC default 8).
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0));
    reg.observe('s0:1', vec(0.98, 0.2), 5, seg('s0:1', 6000));
    const before = reg.centroidFor(reg.snapshot()[0].sessionSpeakerId);

    // Same label, orthogonal (completely different) voice — must NOT fold into the sticky speaker.
    reg.observe('s0:1', vec(0, 1), 5, seg('s0:1', 20000));

    const snap = reg.snapshot();
    expect(snap).toHaveLength(2);
    const original = snap.find((s) => s.sonioxLabels.includes('s0:1'))!;
    const reused = snap.find((s) => s.sonioxLabels.some((l) => l.startsWith('s0:1@')))!;
    expect(reused).toBeDefined();
    expect(reused.sonioxLabels).toEqual(['s0:1@2']);
    const after = reg.centroidFor(original.sessionSpeakerId);
    expect(after).toEqual(before); // untouched
  });

  it('(d) two session speakers whose centroids converge get merged, the larger speechSec side wins', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // speaker A: speechSec=5

    // speaker B starts distinctly different (cosine 0.3 < match threshold 0.4)...
    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000));
    // ...then its second observation (not yet sticky, no recycle check) pulls its centroid toward A's.
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 16000)); // speaker B total speechSec=10 > A's 5

    const snap = reg.snapshot();
    const active = snap.filter((s) => !s.mergedInto);
    const merged = snap.filter((s) => s.mergedInto);
    expect(active).toHaveLength(1);
    expect(merged).toHaveLength(1);
    expect(active[0].sonioxLabels.sort()).toEqual(['s0:1', 's0:2']);
    expect(active[0].liveSpeechSec).toBeCloseTo(15);
    expect(merged[0].mergedInto).toBe(active[0].sessionSpeakerId);
  });

  it('(e) two genuinely different voices never merge', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0));
    reg.observe('s0:2', vec(0, 1), 5, seg('s0:2', 10000));
    const snap = reg.snapshot();
    expect(snap.filter((s) => !s.mergedInto)).toHaveLength(2);
  });

  it('(f) sticky only turns on after >=2 turns AND >= LIVE_MIN_SPEECH_SEC of speech', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 9, seg('s0:1', 0)); // enough speech, but only 1 turn
    expect(reg.candidatesForProfileMatch()).toHaveLength(0);

    reg.observe('s0:1', vec(0.99, 0.14), 1, seg('s0:1', 12000)); // 2nd turn -> now sticky
    expect(reg.candidatesForProfileMatch()).toHaveLength(1);
  });

  it('(g) alreadyProcessed blocks a duplicate turn inside the overlap window', () => {
    const reg = new MeetingSessionRegistry('m1');
    const s = seg('s0:1', 5000);
    reg.observe('s0:1', vec(1, 0), 4, s);
    expect(reg.alreadyProcessed(s)).toBe(true);
    reg.observe('s0:1', vec(1, 0), 4, s); // resent (e.g. draft then final) — must be a no-op
    expect(reg.snapshot()[0].liveSpeechSec).toBeCloseTo(4);
  });

  it('(h) a turn spanning a chunk boundary is deferred, then embedded exactly once on the next chunk', () => {
    const reg = new MeetingSessionRegistry('m1');
    const crossing = seg('s0:1', 58_000, 63_000, false);
    reg.defer(crossing);
    expect(reg.takeDeferred()).toEqual([crossing]);
    expect(reg.takeDeferred()).toEqual([]); // cleared after the first read

    reg.observe('s0:1', vec(1, 0), 5, crossing);
    expect(reg.alreadyProcessed(crossing)).toBe(true);
    // The same turn resent (now `final: true`) must not embed a second time.
    const finalVersion = { ...crossing, final: true };
    reg.observe('s0:1', vec(1, 0), 5, finalVersion);
    expect(reg.snapshot()[0].liveSpeechSec).toBeCloseTo(5);
  });

  it('clock: noteDecoded advances decodedSecBefore, a discontinuity clears the ring', () => {
    const reg = new MeetingSessionRegistry('m1');
    expect(reg.decodedSecBefore(0)).toBe(0);
    reg.ringSet(vec(1, 2, 3));
    reg.noteDecoded(0, 60);
    expect(reg.decodedSecBefore(1)).toBe(60);
    expect(reg.ringTake().length).toBe(3);

    reg.ringSet(vec(1, 2, 3));
    reg.markDiscontinuity(1);
    expect(reg.isDegraded()).toBe(true);
    expect(reg.ringTake().length).toBe(0);
  });

  it('markDropped advances the clock by the declared durationMs even though nothing ran', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.markDropped(2, 60_000);
    expect(reg.decodedSecBefore(3)).toBe(60);
    expect(reg.isDegraded()).toBe(true);
  });

  it('snapshotChanged/markPersisted gate repeated writes of identical state', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0));
    expect(reg.snapshotChanged()).toBe(true);
    reg.markPersisted();
    expect(reg.snapshotChanged()).toBe(false);
    reg.observe('s0:2', vec(0, 1), 5, seg('s0:2', 10_000));
    expect(reg.snapshotChanged()).toBe(true);
  });

  it('loadFrom rebuilds sticky, already-attempted session speakers from persisted rows', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.loadFrom([
      {
        sessionSpeakerId: 'ss-1',
        sonioxLabels: ['s0:1'],
        centroid: vec(1, 0),
        liveSpeechSec: 12,
        profileId: 'profile-1',
        displayName: 'An',
        nameSource: 'live',
        colorKey: 'blue',
      },
    ]);
    expect(reg.candidatesForProfileMatch()).toHaveLength(0); // already has a profileId
    expect(reg.snapshot()).toEqual([
      {
        sessionSpeakerId: 'ss-1',
        sonioxLabels: ['s0:1'],
        displayName: 'An',
        profileId: 'profile-1',
        nameSource: 'live',
        liveConfidence: undefined,
        liveSpeechSec: 12,
        colorKey: 'blue',
        resolved: true,
        mergedInto: undefined,
      },
    ]);
    expect(reg.snapshotChanged()).toBe(false); // restored state is considered already-persisted
  });
});

describe('diagnostics facts (onFact)', () => {
  function collectFacts() {
    const facts: SpeakerRegistryFact[] = [];
    return { facts, onFact: (f: SpeakerRegistryFact) => facts.push(f) };
  }

  it('replaying a logged decisionScore against the threshold reproduces the fold/new decision the registry actually made', () => {
    const reg = new MeetingSessionRegistry('m1');
    const { facts, onFact } = collectFacts();

    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0), onFact); // no candidates yet -> new
    // Different (never-before-seen) label, near-identical embedding -> matched via matchSpeaker, not direct label ownership.
    reg.observe('s0:3', vec(0.99, 0.14), 5, seg('s0:3', 8000), onFact);
    // A genuinely different voice on another brand-new label -> no candidate clears the threshold.
    reg.observe('s0:9', vec(0, 1), 5, seg('s0:9', 20000), onFact);

    const observeFacts = facts.filter((f): f is Extract<SpeakerRegistryFact, { kind: 'observe' }> => f.kind === 'observe');
    expect(observeFacts).toHaveLength(3);
    const [first, matched, brandNew] = observeFacts;

    expect(first.action).toBe('new');
    expect(first.decisionScore).toBe(0);

    // The logged score alone, replayed against the SAME threshold the registry used, reproduces its 'folded' call.
    expect(matched.action).toBe('folded');
    expect(matched.decisionScore).toBeGreaterThanOrEqual(env.speakerSessionMatchThreshold);

    expect(brandNew.action).toBe('new');
    expect(brandNew.decisionScore).toBe(0);
    // The 'new' decision is reproducible from the logged per-candidate scores, not asserted blind.
    expect(brandNew.scores.every((s) => s.cosMaxHeld < env.speakerSessionMatchThreshold)).toBe(true);
  });

  it('flags the specific turn where a recycled label opens a fresh instance as action:"reinstanced"', () => {
    const reg = new MeetingSessionRegistry('m1');
    const { facts, onFact } = collectFacts();

    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0), onFact);
    reg.observe('s0:1', vec(0.98, 0.2), 5, seg('s0:1', 6000), onFact); // sticky now
    reg.observe('s0:1', vec(0, 1), 5, seg('s0:1', 20000), onFact); // recycled for a different voice

    const observeFacts = facts.filter((f): f is Extract<SpeakerRegistryFact, { kind: 'observe' }> => f.kind === 'observe');
    expect(observeFacts.map((f) => f.action)).toEqual(['new', 'folded', 'reinstanced']);
  });

  it('maybeMerge emits a MergeFact with each side\'s speech total captured BEFORE the merge combined them', () => {
    const reg = new MeetingSessionRegistry('m1');
    const { facts, onFact } = collectFacts();

    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0), onFact); // speaker A: speechSec=5
    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000), onFact); // speaker B starts distinct
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 16000), onFact); // B's centroid converges onto A -> triggers the merge

    const mergeFact = facts.find((f): f is Extract<SpeakerRegistryFact, { kind: 'merge' }> => f.kind === 'merge');
    expect(mergeFact).toBeDefined();
    const survivor = reg.snapshot().find((s) => !s.mergedInto)!;
    expect(mergeFact!.winnerId).toBe(survivor.sessionSpeakerId);
    expect(mergeFact!.winnerSpeechSec).toBeCloseTo(10); // B's own total right before absorbing A
    expect(mergeFact!.loserSpeechSec).toBeCloseTo(5); // A's own total right before being absorbed
    expect(mergeFact!.winnerNamed).toBe(false);
    expect(mergeFact!.loserNamed).toBe(false);
  });

  it('applyProfileMatch returns the post-increment attempt count (0 for an unknown id)', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 9, seg('s0:1', 0));
    reg.observe('s0:1', vec(0.99, 0.14), 1, seg('s0:1', 12000));
    const id = reg.snapshot()[0].sessionSpeakerId;

    expect(reg.applyProfileMatch(id, { confidence: 0.2 })).toBe(1);
    expect(reg.applyProfileMatch(id, { confidence: 0.3 })).toBe(2);
    expect(reg.applyProfileMatch('unknown-id', { confidence: 0 })).toBe(0);
  });
});

describe('diagnostics buffer', () => {
  it('push/drain round-trips events and drain empties the buffer', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.pushDiagnosticEvent({ type: 'chunk', seq: 0 });
    reg.pushDiagnosticEvent({ type: 'gap', fromSeq: 0, toSeq: 2 });
    expect(reg.drainDiagnosticEvents()).toEqual([
      { type: 'chunk', seq: 0 },
      { type: 'gap', fromSeq: 0, toSeq: 2 },
    ]);
    expect(reg.drainDiagnosticEvents()).toEqual([]);
  });

  it('aliasForProfile assigns stable, sequential per-meeting aliases', () => {
    const reg = new MeetingSessionRegistry('m1');
    expect(reg.aliasForProfile('profile-a')).toBe('p1');
    expect(reg.aliasForProfile('profile-b')).toBe('p2');
    expect(reg.aliasForProfile('profile-a')).toBe('p1'); // stable on repeat
  });

  it('the diagnostics buffer is dropped with the registry on LRU eviction', () => {
    const store = new SessionRegistryStore(1);
    const reg = store.get('m1');
    reg.pushDiagnosticEvent({ type: 'chunk', seq: 0 });
    store.get('m2'); // cap=1 -> evicts m1

    expect(store.has('m1')).toBe(false);
    const fresh = store.get('m1'); // a brand-new registry — never touched by the pushDiagnosticEvent call above
    expect(fresh.drainDiagnosticEvents()).toEqual([]);
  });
});

describe('SessionRegistryStore', () => {
  it('reuses the same registry instance for the same meetingId', () => {
    const store = new SessionRegistryStore(4);
    const a = store.get('m1');
    const b = store.get('m1');
    expect(a).toBe(b);
  });

  it('evicts the least-recently-used meeting once the concurrency cap is reached', () => {
    const store = new SessionRegistryStore(2);
    const m1 = store.get('m1');
    store.get('m2');
    store.get('m1'); // touch m1 so it is now more-recently-used than m2
    store.get('m3'); // cap=2 -> evicts m2 (least recently used), not m1

    expect(store.has('m2')).toBe(false);
    expect(store.has('m1')).toBe(true);
    expect(store.get('m1')).toBe(m1);
  });
});
