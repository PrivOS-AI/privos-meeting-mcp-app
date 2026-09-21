import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../env.js';
import { MeetingSessionRegistry, SessionRegistryStore, type SpeakerRegistryFact } from './session-speaker-registry.js';

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

function seg(speaker: string, startMs: number, endMs = startMs + 3000, final = true) {
  return { speaker, startMs, endMs, final };
}

function collectFacts() {
  const facts: SpeakerRegistryFact[] = [];
  return { facts, onFact: (f: SpeakerRegistryFact) => facts.push(f) };
}

function observeFactsOf(facts: readonly SpeakerRegistryFact[]) {
  return facts.filter((f): f is Extract<SpeakerRegistryFact, { kind: 'observe' }> => f.kind === 'observe');
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

    // speaker B starts distinctly different (cosine 0.3 < match threshold 0.4; brand new -> no fold-check yet)...
    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000));
    // ...then walks toward A in two more turns, each clearing the per-turn
    // fold-verify check against its OWN best held vector (0.81, then 0.8 —
    // "verify non-sticky folds too" now runs on every turn, not just once
    // sticky, so a single blind jump like the old fixture used would instead
    // open a fresh instance; see the diagnostics test below for that case).
    reg.observe('s0:2', vec(0.8, 0.6), 5, seg('s0:2', 16000));
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 22000)); // B's centroid (speechSec=15) now clears the 0.6 merge threshold with A (cos~0.804)

    const snap = reg.snapshot();
    const active = snap.filter((s) => !s.mergedInto);
    const merged = snap.filter((s) => s.mergedInto);
    expect(active).toHaveLength(1);
    expect(merged).toHaveLength(1);
    expect(active[0].sonioxLabels.sort()).toEqual(['s0:1', 's0:2']);
    expect(active[0].liveSpeechSec).toBeCloseTo(20); // A(5) + B(15)
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
    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000), onFact); // speaker B starts distinct, brand new
    reg.observe('s0:2', vec(0.8, 0.6), 5, seg('s0:2', 16000), onFact); // folds (cos to B's own held vector = 0.81 >= ASSIGN)
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 22000), onFact); // folds (cos = 0.8 >= ASSIGN) -> B's centroid converges onto A -> triggers the merge

    const mergeFact = facts.find((f): f is Extract<SpeakerRegistryFact, { kind: 'merge' }> => f.kind === 'merge');
    expect(mergeFact).toBeDefined();
    const survivor = reg.snapshot().find((s) => !s.mergedInto)!;
    expect(mergeFact!.winnerId).toBe(survivor.sessionSpeakerId);
    expect(mergeFact!.winnerSpeechSec).toBeCloseTo(15); // B's own total right before absorbing A
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

    // A THIRD embedding orthogonal to the FIRST but close to the SECOND — each
    // turn's own per-turn fold-verify check (against the best-scoring held
    // vector, not necessarily the first) clears ASSIGN, yet the resulting
    // pairwise min across all three held vectors is still ~0 (verify
    // non-sticky folds too: a single big jump straight from the first turn
    // would instead open a fresh instance, see the diagnostics test below).
    reg.observe('s0:1', vec(0.5, 0.866), 5, seg('s0:1', 6000)); // cos to turn 1 = 0.5 >= ASSIGN
    reg.observe('s0:1', vec(0, 1), 5, seg('s0:1', 12000)); // cos to turn 2 = 0.866 >= ASSIGN (max mode); cos to turn 1 = 0
    const stats = reg.coherenceFor(id)!;
    expect(stats.rangeCount).toBe(3);
    expect(stats.minPairwiseCosine).toBeCloseTo(0);
    expect(stats.durationSec).toBeCloseTo(15);

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

    // Two more A-ward embeddings walk B's centroid toward A's, each clearing
    // its own per-turn fold-verify check (cos to B's best held vector: 0.8,
    // then 0.6) — well above the 0.6 merge threshold once folded in.
    reg.observe('s0:2', vec(0.6, 0.8), 5, seg('s0:2', 26000), onFact);
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 32000), onFact);

    const snap = reg.snapshot();
    expect(snap.filter((s) => !s.mergedInto)).toHaveLength(2);
    expect(snap.find((s) => s.sessionSpeakerId === idA)!.displayName).toBe('An');
    expect(snap.find((s) => s.sessionSpeakerId === idB)!.displayName).toBe('Binh');

    const blocked = facts.find((f): f is Extract<SpeakerRegistryFact, { kind: 'merge' }> => f.kind === 'merge' && f.blockedBy === 'identity');
    expect(blocked).toBeDefined();
    expect(blocked!.cos).toBeGreaterThanOrEqual(env.speakerSessionMergeThreshold);
  });

  it('(b) a single spike >= threshold does not merge when SPEAKER_SESSION_MERGE_STREAK > 1', () => {
    env.speakerSessionMergeStreak = 3;
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // A: speechSec=5
    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000)); // B turn 1: brand new, cos(A,B)=0.3 < threshold
    reg.observe('s0:2', vec(0.8, 0.6), 5, seg('s0:2', 16000)); // B turn 2: folds (cos to turn 1 = 0.81 >= ASSIGN); mean cos to A ~0.58, still < merge threshold
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 22000)); // B turn 3: folds (cos to turn 2 = 0.8 >= ASSIGN); mean cos to A ~0.80 crosses the 0.6 merge threshold — but that's only streak=1

    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(2);
  });

  it('(c) 3 consecutive checks with a changed centroid each time DOES merge at SPEAKER_SESSION_MERGE_STREAK=3', () => {
    env.speakerSessionMergeStreak = 3;
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // A: speechSec=5, centroid=(1,0)

    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000)); // B turn 1: brand new, cos(A,B)=0.3 < merge threshold — no check counted
    reg.observe('s0:2', vec(0.8, 0.6), 5, seg('s0:2', 16000)); // B turn 2 (priming): folds (cos to turn 1 = 0.81 >= ASSIGN); mean cos to A ~0.58 < merge threshold — still no check counted
    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(2);

    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 22000)); // B turn 3: folds (cos to turn 2 = 0.8 >= ASSIGN); mean cos to A ~0.80 >= threshold, streak=1 (changed from "no prior")
    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(2);

    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 28000)); // B turn 4: mean changes again, cos ~0.89, streak=2
    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(2);

    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 34000)); // B turn 5: mean changes again, cos ~0.94, streak=3 -> merges
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

    // Walk the smaller speaker's centroid onto the bigger one's in two more
    // turns, each clearing its own per-turn fold-verify check (cos to its best
    // held vector: 0.8, then 0.6) — one side named, no identity conflict.
    reg.observe('s0:2', vec(0.6, 0.8), 5, seg('s0:2', 36000));
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 42000));

    const active = reg.snapshot().filter((s) => !s.mergedInto);
    expect(active).toHaveLength(1);
    expect(active[0].displayName).toBe('An');
    expect(active[0].nameSource).toBe('user');
    expect(active[0].privosUserId).toBe('user-1');
    // The bigger speaker's own speech still dominates the combined total — only the NAME follows precedence, not the survivor id.
    expect(active[0].liveSpeechSec).toBeCloseTo(35); // A(20) + B(5+5+5)
  });

  it('(e) a user-confirmed name outranks an existing live/profile-matched name, even on the speechSec-winning side', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 20, seg('s0:1', 0));
    const winnerId = reg.snapshot()[0].sessionSpeakerId;
    reg.applyProfileMatch(winnerId, { profileId: 'profile-1', displayName: 'Live Guess', confidence: 0.7 });

    reg.observe('s0:2', vec(0, 1), 5, seg('s0:2', 30000));
    const loserId = reg.snapshot().find((s) => s.sessionSpeakerId !== winnerId)!.sessionSpeakerId;
    reg.applyUserIdentity(loserId, { displayName: 'Confirmed Name' });

    // Two-step ramp — each turn clears its own per-turn fold-verify check.
    reg.observe('s0:2', vec(0.6, 0.8), 5, seg('s0:2', 36000));
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 42000));

    const active = reg.snapshot().filter((s) => !s.mergedInto);
    expect(active).toHaveLength(1);
    expect(active[0].displayName).toBe('Confirmed Name');
    expect(active[0].nameSource).toBe('user');
  });

  it('min-speech gate: both sides must clear SPEAKER_SESSION_MERGE_MIN_SPEECH_SEC (and >=3 embeddings each) once enabled', () => {
    env.speakerSessionMergeMinSpeechSec = 15;
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // A: speechSec=5 < 15
    reg.observe('s0:2', vec(0.3, 0.9539), 5, seg('s0:2', 10000)); // B turn 1: brand new
    reg.observe('s0:2', vec(0.8, 0.6), 5, seg('s0:2', 16000)); // B turn 2: folds (cos to turn 1 = 0.81 >= ASSIGN)
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 22000)); // B turn 3: folds (cos to turn 2 = 0.8 >= ASSIGN); B crosses the merge threshold, but A hasn't spoken enough

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

    // Two-step ramp toward A — each turn clears its own per-turn fold-verify
    // check (cos to B's best held vector: 0.8, then 0.6). The FIRST check that
    // clears the merge threshold (turn 3, cos~0.66) is enough despite streak=5,
    // because it's explicit.
    reg.observe('s0:2', vec(0.6, 0.8), 5, seg('s0:2', 16000));
    reg.observe('s0:2', vec(1, 0), 5, seg('s0:2', 22000));

    expect(reg.snapshot().filter((s) => !s.mergedInto)).toHaveLength(1);
  });
});

describe('centroid update gating (UPDATE threshold, duration gate, anchors)', () => {
  const defaults = {
    updateThreshold: env.speakerSessionUpdateThreshold,
    updateMinSegmentSec: env.speakerUpdateMinSegmentSec,
    scoreMode: env.speakerSessionScoreMode,
    centroidMode: env.speakerSessionCentroidMode,
  };

  afterEach(() => {
    env.speakerSessionUpdateThreshold = defaults.updateThreshold;
    env.speakerUpdateMinSegmentSec = defaults.updateMinSegmentSec;
    env.speakerSessionScoreMode = defaults.scoreMode;
    env.speakerSessionCentroidMode = defaults.centroidMode;
  });

  it('(a) a run of 0.45-cos intruder turns leaves the centroid unchanged once UPDATE is stricter than ASSIGN', () => {
    env.speakerSessionUpdateThreshold = 0.5; // ASSIGN stays at the default 0.4
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // brand new -> provisional seed, centroid=(1,0)
    const id = reg.snapshot()[0].sessionSpeakerId;
    const before = reg.centroidFor(id);

    const intruder = vec(0.45, 0.893); // cos to (1,0) = 0.45: clears ASSIGN(0.4) but not UPDATE(0.5)
    const { facts, onFact } = collectFacts();
    for (let i = 0; i < 5; i++) reg.observe('s0:1', intruder, 5, seg('s0:1', 10_000 + i * 6000), onFact);

    expect(reg.centroidFor(id)).toEqual(before); // untouched
    const observed = observeFactsOf(facts);
    expect(observed).toHaveLength(5);
    expect(observed.every((f) => f.action === 'folded')).toBe(true); // still attributed to the same speaker
    expect(observed.every((f) => f.updateAction === 'rejected-low-cos')).toBe(true); // never touches the centroid
  });

  it('(b) turns shorter than SPEAKER_UPDATE_MIN_SEGMENT_SEC never move the centroid, even at cos~1', () => {
    env.speakerUpdateMinSegmentSec = 3;
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // brand new, 5s >= min -> provisional seed
    const id = reg.snapshot()[0].sessionSpeakerId;
    const before = reg.centroidFor(id);

    const { facts, onFact } = collectFacts();
    reg.observe('s0:1', vec(0.99, 0.14), 2.5, seg('s0:1', 10_000, 12_500), onFact); // near-identical voice, too short
    reg.observe('s0:1', vec(0.99, 0.14), 2.5, seg('s0:1', 16_000, 18_500), onFact);

    expect(reg.centroidFor(id)).toEqual(before);
    const observed = observeFactsOf(facts);
    expect(observed.every((f) => f.action === 'folded' && f.updateAction === 'rejected-short')).toBe(true);
  });

  it('(c) a non-sticky label bound to a foreign voice re-matches instead of folding blindly (today: folded blindly)', () => {
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // only 1 turn -> NOT sticky yet
    reg.observe('s0:1', vec(0, 1), 5, seg('s0:1', 10_000)); // completely different voice, SAME label

    const active = reg.snapshot().filter((s) => !s.mergedInto);
    expect(active).toHaveLength(2); // opened a fresh instance instead of contaminating the original
    const original = active.find((s) => s.sonioxLabels.includes('s0:1'))!;
    const reused = active.find((s) => s.sonioxLabels.some((l) => l.startsWith('s0:1@')))!;
    expect(reused).toBeDefined();
    expect(reg.centroidFor(original.sessionSpeakerId)).toEqual(vec(1, 0)); // original untouched
  });

  it('(d) 200 alternating turns under SPEAKER_SESSION_CENTROID_MODE=anchors: centroid-to-anchor cosine stays >=0.95 (no drift)', () => {
    env.speakerSessionCentroidMode = 'anchors';
    const reg = new MeetingSessionRegistry('m1');
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0)); // brand new -> provisional seed
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 6000)); // 2nd turn, durSec>=4 -> qualifies as the FIRST pinned anchor
    const id = reg.snapshot()[0].sessionSpeakerId;

    // Two unit vectors jittered a few degrees off the anchor's own axis — a
    // realistic mic-noise range, always clearing both ASSIGN/UPDATE and the
    // anchor-drift check — alternated 200 times to fill (and keep refilling)
    // the 10-item recent window many times over.
    const jitterPlus = vec(Math.cos((5 * Math.PI) / 180), Math.sin((5 * Math.PI) / 180));
    const jitterMinus = vec(Math.cos((-5 * Math.PI) / 180), Math.sin((-5 * Math.PI) / 180));
    for (let i = 0; i < 200; i++) {
      const v = i % 2 === 0 ? jitterPlus : jitterMinus;
      reg.observe('s0:1', v, 5, seg('s0:1', 12_000 + i * 6000));
    }

    const anchorOnlyCentroid = vec(1, 0); // this speaker's only anchor is exactly (1,0), pinned since turn 2
    const finalCentroid = reg.centroidFor(id)!;
    const dot = finalCentroid[0] * anchorOnlyCentroid[0] + finalCentroid[1] * anchorOnlyCentroid[1];
    const cos = dot / Math.sqrt(finalCentroid[0] ** 2 + finalCentroid[1] ** 2);
    expect(cos).toBeGreaterThanOrEqual(0.95);
  });

  it('(e) the provisional seed is replaced by the first anchor-quality embedding', () => {
    env.speakerSessionCentroidMode = 'anchors';
    const reg = new MeetingSessionRegistry('m1');
    const { facts, onFact } = collectFacts();
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0), onFact); // brand new -> provisional seed
    const id = reg.snapshot()[0].sessionSpeakerId;
    expect(reg.coherenceFor(id)!.rangeCount).toBe(1); // only the provisional seed held so far

    reg.observe('s0:1', vec(0.99, 0.14), 5, seg('s0:1', 6000), onFact); // durSec>=4 -> qualifies as the first real anchor

    const observed = observeFactsOf(facts);
    expect(observed.map((f) => f.updateAction)).toEqual(['provisional', 'anchor']);
    // The provisional seed is GONE, not merely outweighed — only the anchor remains held.
    expect(reg.coherenceFor(id)!.rangeCount).toBe(1);
    expect(reg.centroidFor(id)).toEqual(vec(0.99, 0.14));
  });

  it('a deploy with DEFAULTS (score-mode=max, centroid-mode=fifo, UPDATE=ASSIGN, update-min=SPEAKER_MIN_SEGMENT_SEC) never rejects a normal turn, reproducing today\'s decision behaviour exactly', () => {
    expect(env.speakerSessionScoreMode).toBe('max');
    expect(env.speakerSessionCentroidMode).toBe('fifo');
    expect(env.speakerSessionUpdateThreshold).toBe(env.speakerSessionMatchThreshold);
    expect(env.speakerUpdateMinSegmentSec).toBe(env.speakerMinSegmentSec);

    const reg = new MeetingSessionRegistry('m1');
    const { facts, onFact } = collectFacts();
    // The exact fixture from `MeetingSessionRegistry` tests (a)/(b) above,
    // replayed with the diagnostics hook attached.
    reg.observe('s0:1', vec(1, 0), 5, seg('s0:1', 0), onFact);
    reg.observe('s0:1', vec(0.95, 0.31), 5, seg('s0:1', 6000), onFact);
    reg.observe('s0:2', vec(0, 1), 5, seg('s0:2', 12_000), onFact);
    reg.observe('s0:3', vec(0.99, 0.14), 5, seg('s0:3', 18_000), onFact); // matches s0:1's speaker via bestSessionMatch

    // Under neutral defaults, nothing is ever rejected for update — every held
    // turn is either the brand-new exemption (`provisional`) or folds straight
    // into the FIFO mean (`recent`), exactly like the pre-phase-6 code that
    // updated the centroid unconditionally on every fold.
    expect(observeFactsOf(facts).map((f) => f.updateAction)).toEqual(['provisional', 'recent', 'provisional', 'recent']);

    const speakerA = reg.snapshot().find((s) => s.sonioxLabels.includes('s0:1'))!;
    const centroidA = reg.centroidFor(speakerA.sessionSpeakerId)!;
    // Plain (unweighted) FIFO mean of all 3 held embeddings — today's exact formula.
    expect(centroidA[0]).toBeCloseTo((1 + 0.95 + 0.99) / 3);
    expect(centroidA[1]).toBeCloseTo((0 + 0.31 + 0.14) / 3);
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
