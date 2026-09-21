import { afterEach, describe, expect, it } from 'vitest';

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

  it('(d) two session speakers whose centroids converge get merged, the larger speechSec side wins (neutral defaults: streak=1, minSpeech=0)', () => {
    expect(env.speakerSessionMergeStreak).toBe(1);
    expect(env.speakerSessionMergeMinSpeechSec).toBe(0);
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

  it('the absolute part-stamp anchor starts null and records only what is explicitly noted valid', () => {
    const reg = new MeetingSessionRegistry('m1');
    expect(reg.lastPartStampForValidation()).toBeNull();
    reg.noteValidPartStamp(0, 0, 60_000);
    expect(reg.lastPartStampForValidation()).toEqual({ seq: 0, partStartMs: 0, durationMs: 60_000 });
    reg.noteValidPartStamp(1, 60_000, 60_000);
    expect(reg.lastPartStampForValidation()).toEqual({ seq: 1, partStartMs: 60_000, durationMs: 60_000 });
  });

  it('estimateUploadLagMs anchors on the first call (returns 0) then reports drift against that anchor', () => {
    const reg = new MeetingSessionRegistry('m1');
    // Meeting starts at server wall time 1_000_000; part 0 (emit stamp 0) arrives essentially instantly.
    expect(reg.estimateUploadLagMs(1_000_000, 0, 60_000)).toBe(0);
    // Part 1's emit stamp is 60_000 -> expected arrival 1_060_000; it actually arrived 2s late.
    expect(reg.estimateUploadLagMs(1_062_000, 60_000, 60_000)).toBe(2_000);
    // A part arriving EARLY relative to the anchor reports a negative lag.
    expect(reg.estimateUploadLagMs(1_119_500, 120_000, 60_000)).toBe(-500);
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
    reg.markPersisted(reg.snapshotHash());
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
    expect(mergeFact!.streak).toBe(1); // neutral default SPEAKER_SESSION_MERGE_STREAK=1 -> satisfied on the first qualifying check
    expect(mergeFact!.blockedBy).toBeUndefined(); // this check actually merged
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

  it('applyUserIdentity sets nameSource:user and resolved:true; a later profile match never overwrites it', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 9, seg('s0:1', 0));
    const id = reg.snapshot()[0].sessionSpeakerId;

    expect(reg.applyUserIdentity(id, { displayName: 'Thanh', privosUserId: 'user-9' })).toBe(true);
    let snap = reg.snapshot()[0];
    expect(snap.displayName).toBe('Thanh');
    expect(snap.nameSource).toBe('user');
    expect(snap.privosUserId).toBe('user-9');
    expect(snap.resolved).toBe(true);

    // A live guess arriving afterwards must never downgrade the user identity (plan.md: "user identity beats guesses").
    reg.applyProfileMatch(id, { profileId: 'guessed-profile', displayName: 'Someone Else', confidence: 0.9 });
    snap = reg.snapshot()[0];
    expect(snap.displayName).toBe('Thanh');
    expect(snap.nameSource).toBe('user');
    expect(snap.profileId).toBeUndefined();

    expect(reg.applyUserIdentity('unknown-id', { displayName: 'X' })).toBe(false);
  });

  it('coherenceFor reports minPairwiseCosine=1/rangeCount=1 for a single held embedding, and the real min for several', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0));
    const id = reg.snapshot()[0].sessionSpeakerId;
    expect(reg.coherenceFor(id)).toEqual({ minPairwiseCosine: 1, rangeCount: 1, durationSec: 5 });

    reg.observe('s0:1', vec(0, 1), 5, seg('s0:1', 6000)); // orthogonal — drags the min down
    const stats = reg.coherenceFor(id)!;
    expect(stats.rangeCount).toBe(2);
    expect(stats.minPairwiseCosine).toBeCloseTo(0);
    expect(stats.durationSec).toBeCloseTo(10);

    expect(reg.coherenceFor('unknown-id')).toBeNull();
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

describe('merge hardening', () => {
  const defaultStreak = env.speakerSessionMergeStreak;
  const defaultMinSpeech = env.speakerSessionMergeMinSpeechSec;

  afterEach(() => {
    env.speakerSessionMergeStreak = defaultStreak;
    env.speakerSessionMergeMinSpeechSec = defaultMinSpeech;
  });

  it('(a) two speakers who already carry DIFFERENT confirmed names never merge, even at cos 0.9', () => {
    const reg = new MeetingSessionRegistry('m1');
    const { facts, onFact } = (() => {
      const events: SpeakerRegistryFact[] = [];
      return { facts: events, onFact: (f: SpeakerRegistryFact) => events.push(f) };
    })();

    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0), onFact);
    const idA = reg.snapshot()[0].sessionSpeakerId;
    reg.applyUserIdentity(idA, { displayName: 'An' });

    // B starts orthogonal (cos 0 with A) so naming it carries no merge risk yet.
    reg.observe('s0:2', vec(0, 1), 5, seg('s0:2', 20000), onFact);
    const idB = reg.snapshot().find((s) => s.sessionSpeakerId !== idA)!.sessionSpeakerId;
    reg.applyUserIdentity(idB, { displayName: 'Binh' });

    // A second, heavily A-ward embedding pulls B's centroid to cos 0.9 with A's — well above the 0.6 merge threshold.
    reg.observe('s0:2', vec(3.6, 0.7436), 5, seg('s0:2', 26000), onFact);

    const snap = reg.snapshot();
    expect(snap.filter((s) => !s.mergedInto)).toHaveLength(2);
    expect(snap.find((s) => s.sessionSpeakerId === idA)!.displayName).toBe('An');
    expect(snap.find((s) => s.sessionSpeakerId === idB)!.displayName).toBe('Binh');

    const blocked = facts.find((f): f is Extract<SpeakerRegistryFact, { kind: 'merge' }> => f.kind === 'merge' && f.blockedBy === 'identity');
    expect(blocked).toBeDefined();
    expect(blocked!.cos).toBeCloseTo(0.9, 1);
  });

  it('(b) a single spike >= threshold does not merge when SPEAKER_SESSION_MERGE_STREAK > 1', () => {
    env.speakerSessionMergeStreak = 3;
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // A: speechSec=5
    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000)); // B starts distinct (cos 0.3 < threshold)
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 16000)); // B's centroid crosses the 0.6 merge threshold — but that's only streak=1

    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(2);
  });

  it('(c) 3 consecutive checks with a changed centroid each time DOES merge at SPEAKER_SESSION_MERGE_STREAK=3', () => {
    env.speakerSessionMergeStreak = 3;
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // A: speechSec=5, centroid=(1,0)

    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000)); // B turn 1: cos(A,B)=0.3 < threshold — no check counted
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 16000)); // B turn 2: mean cos ~0.81 >= threshold, streak=1 (changed from "no prior")
    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(2);

    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 22000)); // B turn 3: mean changes again, cos ~0.92, streak=2
    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(2);

    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 28000)); // B turn 4: mean changes again, cos ~0.96, streak=3 -> merges
    const snap = reg.snapshot();
    expect(snap.filter((s) => !s.mergedInto)).toHaveLength(1);
  });

  it('(d) reconnect case: a new realtime session index for the SAME voice (s0:1 -> s1:1) still merges under neutral defaults', () => {
    expect(env.speakerSessionMergeStreak).toBe(1);
    expect(env.speakerSessionMergeMinSpeechSec).toBe(0);
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 20, seg('s0:1', 0));
    reg.observe('s1:1', vec(0.99, 0.14), 10, seg('s1:1', 60000)); // reconnect: brand-new label, same voice

    const active = reg.snapshot().filter((s) => !s.mergedInto);
    expect(active).toHaveLength(1);
    expect(active[0].sonioxLabels.sort()).toEqual(['s0:1', 's1:1']);
    expect(active[0].liveSpeechSec).toBeCloseTo(30);
  });

  it('(e) winner keeps the name by precedence (user > profile/live/async > none), regardless of which side has more speech', () => {
    const reg = new MeetingSessionRegistry('m1');
    // The BIGGER speaker (by speechSec) starts unnamed.
    reg.observe('s0:1', vec(1, 0), 20, seg('s0:1', 0));
    const idBig = reg.snapshot()[0].sessionSpeakerId;

    // The SMALLER speaker gets a user-confirmed name.
    reg.observe('s0:2', vec(0, 1), 5, seg('s0:2', 30000));
    const idSmall = reg.snapshot().find((s) => s.sessionSpeakerId !== idBig)!.sessionSpeakerId;
    reg.applyUserIdentity(idSmall, { displayName: 'An', privosUserId: 'user-1' });

    // Converge the smaller speaker's centroid onto the bigger one's — one side named, no identity conflict.
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 36000));

    const active = reg.snapshot().filter((s) => !s.mergedInto);
    expect(active).toHaveLength(1);
    expect(active[0].displayName).toBe('An');
    expect(active[0].nameSource).toBe('user');
    expect(active[0].privosUserId).toBe('user-1');
    // The bigger speaker's own speech still dominates the combined total — only the NAME follows precedence, not the survivor id.
    expect(active[0].liveSpeechSec).toBeCloseTo(30);
  });

  it('(e) a user-confirmed name outranks an existing live/profile-matched name, even on the speechSec-winning side', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 20, seg('s0:1', 0));
    const winnerId = reg.snapshot()[0].sessionSpeakerId;
    reg.applyProfileMatch(winnerId, { profileId: 'profile-1', displayName: 'Live Guess', confidence: 0.7 });

    reg.observe('s0:2', vec(0, 1), 5, seg('s0:2', 30000));
    const loserId = reg.snapshot().find((s) => s.sessionSpeakerId !== winnerId)!.sessionSpeakerId;
    reg.applyUserIdentity(loserId, { displayName: 'Confirmed Name' });

    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 36000));

    const active = reg.snapshot().filter((s) => !s.mergedInto);
    expect(active).toHaveLength(1);
    expect(active[0].displayName).toBe('Confirmed Name');
    expect(active[0].nameSource).toBe('user');
  });

  it('min-speech gate: both sides must clear SPEAKER_SESSION_MERGE_MIN_SPEECH_SEC (and >=3 embeddings each) once enabled', () => {
    env.speakerSessionMergeMinSpeechSec = 15;
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // A: speechSec=5 < 15
    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000));
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 16000)); // B crosses the merge threshold, but A hasn't spoken enough

    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(2);
  });

  it('explicit merge request: the SAME user-given name on both sides merges immediately, bypassing the streak', () => {
    env.speakerSessionMergeStreak = 5; // would otherwise take 5 qualifying checks
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0));
    const idA = reg.snapshot()[0].sessionSpeakerId;
    reg.applyUserIdentity(idA, { displayName: 'An' });

    reg.observe('s0:2', vec(0, 1), 5, seg('s0:2', 10000));
    const idB = reg.snapshot().find((s) => s.sessionSpeakerId !== idA)!.sessionSpeakerId;
    reg.applyUserIdentity(idB, { displayName: 'An' }); // SAME name -> explicit merge request

    // A single qualifying check is enough despite streak=5, because it's explicit.
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 16000));

    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(1);
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
