import { describe, expect, it } from 'vitest';

import { canMerge, identityOutranks, isExplicitMergeRequest, mergePairKey, nextMergeStreak, type MergeCandidate } from './session-speaker-merge-policy.js';

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

function candidate(overrides: Partial<MergeCandidate> = {}): MergeCandidate {
  return { centroid: vec(1, 0), speechSec: 0, embeddingCount: 0, ...overrides };
}

describe('mergePairKey', () => {
  it('is stable regardless of argument order', () => {
    expect(mergePairKey('a', 'b')).toBe(mergePairKey('b', 'a'));
  });

  it('differs for a different pair', () => {
    expect(mergePairKey('a', 'b')).not.toBe(mergePairKey('a', 'c'));
  });
});

describe('canMerge — identity guard', () => {
  it('blocks two DIFFERENT profileIds', () => {
    const a = candidate({ profileId: 'p1' });
    const b = candidate({ profileId: 'p2' });
    expect(canMerge(a, b, { minSpeechSec: 0 })).toEqual({ ok: false, blockedBy: 'identity' });
  });

  it('blocks two different user-given display names', () => {
    const a = candidate({ nameSource: 'user', displayName: 'An' });
    const b = candidate({ nameSource: 'user', displayName: 'Binh' });
    expect(canMerge(a, b, { minSpeechSec: 0 })).toEqual({ ok: false, blockedBy: 'identity' });
  });

  it('allows one side named and the other unnamed', () => {
    const a = candidate({ profileId: 'p1', displayName: 'An' });
    const b = candidate();
    expect(canMerge(a, b, { minSpeechSec: 0 })).toEqual({ ok: true });
  });

  it('allows the same profileId on both sides', () => {
    const a = candidate({ profileId: 'p1' });
    const b = candidate({ profileId: 'p1' });
    expect(canMerge(a, b, { minSpeechSec: 0 })).toEqual({ ok: true });
  });

  it('allows the same user-given display name on both sides', () => {
    const a = candidate({ nameSource: 'user', displayName: 'An' });
    const b = candidate({ nameSource: 'user', displayName: 'An' });
    expect(canMerge(a, b, { minSpeechSec: 0 })).toEqual({ ok: true });
  });
});

describe('canMerge — provider split guard', () => {
  it('blocks two speakers holding different labels of the same provider session', () => {
    expect(canMerge(candidate({ labels: ['s0:1'] }), candidate({ labels: ['s0:2'] }), { minSpeechSec: 0 })).toEqual({ ok: false, blockedBy: 'provider-split' });
  });

  it('allows labels from different sessions, a recycled instance of the same label, and unknown labels', () => {
    expect(canMerge(candidate({ labels: ['s0:1'] }), candidate({ labels: ['s1:2'] }), { minSpeechSec: 0 }).ok).toBe(true);
    expect(canMerge(candidate({ labels: ['s0:1'] }), candidate({ labels: ['s0:1@2'] }), { minSpeechSec: 0 }).ok).toBe(true);
    expect(canMerge(candidate({ labels: ['s0:1'] }), candidate({ labels: ['s0:unknown'] }), { minSpeechSec: 0 }).ok).toBe(true);
  });

  it('the user giving both the same name still merges them', () => {
    const named = { nameSource: 'user' as const, displayName: 'An' };
    expect(canMerge(candidate({ labels: ['s0:1'], ...named }), candidate({ labels: ['s0:2'], ...named }), { minSpeechSec: 0 }).ok).toBe(true);
  });
});

describe('canMerge — min speech gate', () => {
  it('disabled at minSpeechSec=0 (neutral default) regardless of speech/embedding counts', () => {
    const a = candidate({ speechSec: 0, embeddingCount: 0 });
    const b = candidate({ speechSec: 0, embeddingCount: 0 });
    expect(canMerge(a, b, { minSpeechSec: 0 })).toEqual({ ok: true });
  });

  it('blocks when either side has not spoken enough once enabled', () => {
    const a = candidate({ speechSec: 20, embeddingCount: 5 });
    const b = candidate({ speechSec: 5, embeddingCount: 5 });
    expect(canMerge(a, b, { minSpeechSec: 15 })).toEqual({ ok: false, blockedBy: 'min-speech' });
  });

  it('blocks when speech is enough but either side has fewer than 3 held embeddings', () => {
    const a = candidate({ speechSec: 20, embeddingCount: 2 });
    const b = candidate({ speechSec: 20, embeddingCount: 5 });
    expect(canMerge(a, b, { minSpeechSec: 15 })).toEqual({ ok: false, blockedBy: 'min-speech' });
  });

  it('allows once both sides clear speech AND embedding-count bars', () => {
    const a = candidate({ speechSec: 20, embeddingCount: 3 });
    const b = candidate({ speechSec: 15, embeddingCount: 3 });
    expect(canMerge(a, b, { minSpeechSec: 15 })).toEqual({ ok: true });
  });
});

describe('isExplicitMergeRequest', () => {
  it('true for the same profileId on both sides', () => {
    expect(isExplicitMergeRequest(candidate({ profileId: 'p1' }), candidate({ profileId: 'p1' }))).toBe(true);
  });

  it('true for the same user-given display name on both sides', () => {
    expect(isExplicitMergeRequest(candidate({ nameSource: 'user', displayName: 'An' }), candidate({ nameSource: 'user', displayName: 'An' }))).toBe(true);
  });

  it('false when only one side is named', () => {
    expect(isExplicitMergeRequest(candidate({ nameSource: 'user', displayName: 'An' }), candidate())).toBe(false);
  });

  it('false for a live-matched (not user-confirmed) name shared by both sides', () => {
    expect(isExplicitMergeRequest(candidate({ nameSource: 'live', displayName: 'An' }), candidate({ nameSource: 'live', displayName: 'An' }))).toBe(false);
  });
});

describe('identityOutranks', () => {
  it('user beats profile/live/async', () => {
    expect(identityOutranks({ nameSource: 'user' }, { profileId: 'p1' })).toBe(true);
    expect(identityOutranks({ nameSource: 'user' }, { nameSource: 'live' })).toBe(true);
  });

  it('a profile/live/async name beats none', () => {
    expect(identityOutranks({ profileId: 'p1' }, {})).toBe(true);
    expect(identityOutranks({ nameSource: 'async' }, {})).toBe(true);
  });

  it('never outranks on a tie (equal or lower precedence keeps the incumbent)', () => {
    expect(identityOutranks({ nameSource: 'user' }, { nameSource: 'user' })).toBe(false);
    expect(identityOutranks({ profileId: 'p1' }, { nameSource: 'user' })).toBe(false);
    expect(identityOutranks({}, { profileId: 'p1' })).toBe(false);
    expect(identityOutranks({}, {})).toBe(false);
  });
});

describe('nextMergeStreak', () => {
  const A1 = vec(1, 0);
  const A2 = vec(0.99, 0.14);
  const B1 = vec(0.98, 0.2);

  it('resets to 0 when cos falls below threshold', () => {
    const result = nextMergeStreak(undefined, 0.5, 0.6, A1, B1, 3);
    expect(result).toEqual({ count: 0, satisfied: false });
  });

  it('the first-ever qualifying check counts as "changed" — streak=1 satisfies a neutral-default requirement of 1', () => {
    const result = nextMergeStreak(undefined, 0.9, 0.6, A1, B1, 1);
    expect(result).toEqual({ count: 1, satisfied: true });
  });

  it('a single qualifying check does not satisfy a requirement > 1', () => {
    const result = nextMergeStreak(undefined, 0.9, 0.6, A1, B1, 3);
    expect(result).toEqual({ count: 1, satisfied: false });
  });

  it('three consecutive qualifying checks with a changed centroid each time satisfies streak=3', () => {
    const r1 = nextMergeStreak(undefined, 0.9, 0.6, A1, B1, 3);
    const r2 = nextMergeStreak({ count: r1.count, lastCentroidA: A1, lastCentroidB: B1 }, 0.9, 0.6, A2, B1, 3);
    const r3 = nextMergeStreak({ count: r2.count, lastCentroidA: A2, lastCentroidB: B1 }, 0.92, 0.6, A1, B1, 3);
    expect(r1.satisfied).toBe(false);
    expect(r2.satisfied).toBe(false);
    expect(r3).toEqual({ count: 3, satisfied: true });
  });

  it('a qualifying check whose centroids are IDENTICAL to the previous one does not advance the streak', () => {
    const r1 = nextMergeStreak(undefined, 0.9, 0.6, A1, B1, 3);
    const r2 = nextMergeStreak({ count: r1.count, lastCentroidA: A1, lastCentroidB: B1 }, 0.9, 0.6, A1, B1, 3);
    expect(r2).toEqual({ count: 1, satisfied: false });
  });

  it('any check below threshold resets progress — the streak must restart', () => {
    const r1 = nextMergeStreak(undefined, 0.9, 0.6, A1, B1, 3);
    const r2 = nextMergeStreak({ count: r1.count, lastCentroidA: A1, lastCentroidB: B1 }, 0.4, 0.6, A2, B1, 3);
    const r3 = nextMergeStreak(undefined, 0.9, 0.6, A2, B1, 3);
    expect(r2).toEqual({ count: 0, satisfied: false });
    expect(r3).toEqual({ count: 1, satisfied: false });
  });
});
