import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { SpeakerProfile, StoredEmbedding } from './profile-store.js';
import { acceptMatch, acceptProfileMatch, matchSpeaker } from './speaker-matcher.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('session assignment stays separate from profile matching', () => {
  it('session-speaker-registry.ts never imports speaker-matcher.ts (phase-6 separation must hold)', () => {
    const source = readFileSync(path.join(HERE, 'session-speaker-registry.ts'), 'utf8');
    expect(source).not.toMatch(/speaker-matcher(\.js)?['"]/);
    expect(source).not.toMatch(/\bmatchSpeaker\s*\(/);
  });
});

function profile(overrides: Partial<SpeakerProfile> & Pick<SpeakerProfile, 'id' | 'displayName'>): SpeakerProfile {
  return {
    colorKey: 'blue',
    createdByUserId: 'user-1',
    embeddings: [],
    centroid: null,
    dim: 4,
    sampleCount: 0,
    ...overrides,
  };
}

function emb(vector: Float32Array, overrides: Partial<StoredEmbedding> = {}): StoredEmbedding {
  return { vector, meetingId: 'm1', durationSec: 10, createdAt: 'now', speakerKey: 'spk-m1', ...overrides };
}

const A = new Float32Array([1, 0, 0, 0]);
const CLOSE_TO_A = new Float32Array([0.98, 0.02, 0.01, 0.01]);
const B = new Float32Array([0, 1, 0, 0]);

describe('matchSpeaker (top-3 mean scoring, never gated by threshold)', () => {
  it('scores a profile by the MEAN of its top-3 vectors, not the single max', () => {
    // One vector nearly identical to the query, two others orthogonal — max-scoring would have matched this profile at a high threshold; mean-of-top-3 pulls the score down toward (0.999 + 0 + 0) / 3.
    const profiles = [
      profile({ id: 'p1', displayName: 'An', embeddings: [emb(CLOSE_TO_A), emb(B), emb(new Float32Array([0, 0, 1, 0]))] }),
    ];
    const result = matchSpeaker(A, profiles);
    expect(result.best?.profileId).toBe('p1');
    expect(result.best!.score).toBeLessThan(0.5); // far below what max-scoring (~0.999) would have reported
    expect(result.best!.score).toBeGreaterThan(0.3);
  });

  it('a profile with 4+ vectors only averages its best 3, ignoring a 4th weak one', () => {
    const profiles = [
      profile({
        id: 'p1',
        displayName: 'An',
        embeddings: [emb(A), emb(CLOSE_TO_A), emb(new Float32Array([0.97, 0.03, 0, 0])), emb(B)],
      }),
    ];
    const result = matchSpeaker(A, profiles);
    // Top-3 are the three A-like vectors, each scoring close to 1 — the far B vector must not drag the mean down.
    expect(result.best!.score).toBeGreaterThan(0.95);
  });

  it('reports best/second regardless of threshold — matchSpeaker itself never gates', () => {
    const profiles = [profile({ id: 'p1', displayName: 'An', embeddings: [emb(A)] })];
    const result = matchSpeaker(B, profiles);
    expect(result.best?.profileId).toBe('p1');
    expect(result.best!.score).toBeLessThan(0.1);
    expect(result.second).toBeUndefined();
  });

  it('returns an empty result with no profiles', () => {
    expect(matchSpeaker(A, [])).toEqual({ best: undefined, second: undefined });
  });

  it('skips embeddings whose dim does not match the query, without throwing', () => {
    const mismatched = new Float32Array([1, 0, 0]); // dim 3, query is dim 4
    const profiles = [profile({ id: 'p1', displayName: 'An', embeddings: [emb(mismatched)] })];
    expect(() => matchSpeaker(A, profiles)).not.toThrow();
    expect(matchSpeaker(A, profiles).best).toBeUndefined();
  });

  it('reports the runner-up profile/score, never affecting `best`', () => {
    const profiles = [
      profile({ id: 'p1', displayName: 'An', embeddings: [emb(A)] }),
      profile({ id: 'p2', displayName: 'Binh', embeddings: [emb(CLOSE_TO_A)] }),
    ];
    const result = matchSpeaker(A, profiles);
    expect(result.best?.profileId).toBe('p1');
    expect(result.second?.profileId).toBe('p2');
    expect(result.second!.score).toBeLessThan(result.best!.score);
  });
});

describe('acceptMatch (the ONE shared accept/reject decision)', () => {
  it('accepts when best clears threshold and there is no second to be confused with', () => {
    const result = { best: { profileId: 'p1', displayName: 'An', score: 0.9 } };
    const accepted = acceptMatch(result, { threshold: 0.5, margin: 0 });
    expect(accepted).toEqual({ profileId: 'p1', displayName: 'An', confidence: 0.9 });
  });

  it('rejects when best does not clear threshold, however small the margin', () => {
    const result = { best: { profileId: 'p1', displayName: 'An', score: 0.4 } };
    expect(acceptMatch(result, { threshold: 0.5, margin: 0 })).toBeUndefined();
  });

  it('rejects with no best at all', () => {
    expect(acceptMatch({}, { threshold: 0.5, margin: 0 })).toBeUndefined();
  });

  it('margin=0 (neutral default) accepts on threshold alone, even with a close runner-up', () => {
    const result = { best: { profileId: 'p1', displayName: 'An', score: 0.9 }, second: { profileId: 'p2', displayName: 'Binh', score: 0.89 } };
    expect(acceptMatch(result, { threshold: 0.5, margin: 0 })?.profileId).toBe('p1');
  });

  it('two similar profiles → no name rather than a wrong name, once a margin is configured', () => {
    const result = { best: { profileId: 'p1', displayName: 'An', score: 0.9 }, second: { profileId: 'p2', displayName: 'Binh', score: 0.87 } };
    // Gap is 0.03 — below a 0.1 margin, so neither name is trusted.
    expect(acceptMatch(result, { threshold: 0.5, margin: 0.1 })).toBeUndefined();
    // A wider gap (0.2) clears the same margin.
    const wideGap = { best: { profileId: 'p1', displayName: 'An', score: 0.9 }, second: { profileId: 'p2', displayName: 'Binh', score: 0.6 } };
    expect(acceptMatch(wideGap, { threshold: 0.5, margin: 0.1 })?.profileId).toBe('p1');
  });

  it('an end-to-end margin rejection: matchSpeaker + acceptMatch on two profiles both close to the query', () => {
    // p1 and p2 are both close to A (and to each other) — a real ambiguous-voice scenario.
    const nearA1 = new Float32Array([0.95, 0.05, 0.05, 0.02]);
    const nearA2 = new Float32Array([0.9, 0.1, 0.05, 0.02]);
    const profiles = [
      profile({ id: 'p1', displayName: 'An', embeddings: [emb(nearA1)] }),
      profile({ id: 'p2', displayName: 'Binh', embeddings: [emb(nearA2)] }),
    ];
    const match = matchSpeaker(A, profiles);
    expect(acceptMatch(match, { threshold: 0.5, margin: 0.05 })).toBeUndefined();
    expect(acceptMatch(match, { threshold: 0.5, margin: 0 })).toBeDefined(); // neutral default still names the closer one
  });
});

describe('acceptProfileMatch (the SpeakerThresholds-typed entry point)', () => {
  it('delegates to acceptMatch with matchThreshold/matchMargin pulled off the config object', () => {
    const result = { best: { profileId: 'p1', displayName: 'An', score: 0.9 }, second: { profileId: 'p2', displayName: 'Binh', score: 0.6 } };
    expect(acceptProfileMatch(result, { matchThreshold: 0.5, matchMargin: 0 })).toEqual({ profileId: 'p1', displayName: 'An', confidence: 0.9 });
    // A stricter injected margin rejects the SAME result acceptMatch({margin:0}) would have accepted.
    expect(acceptProfileMatch(result, { matchThreshold: 0.5, matchMargin: 0.5 })).toBeUndefined();
  });
});
