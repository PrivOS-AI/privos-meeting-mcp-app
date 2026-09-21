import { describe, expect, it } from 'vitest';

import type { SpeakerProfile } from './profile-store.js';
import { matchSpeaker } from './speaker-matcher.js';

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

const A = new Float32Array([1, 0, 0, 0]);
const CLOSE_TO_A = new Float32Array([0.98, 0.02, 0.01, 0.01]);
const B = new Float32Array([0, 1, 0, 0]);

describe('matchSpeaker', () => {
  it('matches the profile whose embedding is above threshold', () => {
    const profiles = [
      profile({ id: 'p1', displayName: 'An', embeddings: [{ vector: A, meetingId: 'm1', durationSec: 10, createdAt: 'now' }] }),
      profile({ id: 'p2', displayName: 'Binh', embeddings: [{ vector: B, meetingId: 'm1', durationSec: 10, createdAt: 'now' }] }),
    ];
    const result = matchSpeaker(CLOSE_TO_A, profiles, 0.5);
    expect(result.profileId).toBe('p1');
    expect(result.displayName).toBe('An');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('returns no profileId when the best score is below threshold', () => {
    const profiles = [profile({ id: 'p1', displayName: 'An', embeddings: [{ vector: A, meetingId: 'm1', durationSec: 10, createdAt: 'now' }] })];
    const result = matchSpeaker(B, profiles, 0.5);
    expect(result.profileId).toBeUndefined();
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('returns confidence 0 with no profileId when there are no profiles', () => {
    const result = matchSpeaker(A, [], 0.5);
    expect(result).toEqual({ confidence: 0, runnerUpConfidence: 0 });
  });

  it('skips embeddings whose dim does not match the query, without throwing', () => {
    const mismatched = new Float32Array([1, 0, 0]); // dim 3, query is dim 4
    const profiles = [profile({ id: 'p1', displayName: 'An', embeddings: [{ vector: mismatched, meetingId: 'm1', durationSec: 10, createdAt: 'now' }] })];
    expect(() => matchSpeaker(A, profiles, 0.5)).not.toThrow();
    expect(matchSpeaker(A, profiles, 0.5)).toEqual({ confidence: 0, runnerUpConfidence: 0 });
  });

  it('reports the runner-up profile/score as a margin diagnostic, never affecting the accepted match', () => {
    const profiles = [
      profile({ id: 'p1', displayName: 'An', embeddings: [{ vector: A, meetingId: 'm1', durationSec: 10, createdAt: 'now' }] }),
      profile({ id: 'p2', displayName: 'Binh', embeddings: [{ vector: CLOSE_TO_A, meetingId: 'm1', durationSec: 10, createdAt: 'now' }] }),
    ];
    const result = matchSpeaker(A, profiles, 0.5);
    expect(result.profileId).toBe('p1');
    expect(result.bestProfileId).toBe('p1');
    expect(result.runnerUpProfileId).toBe('p2');
    expect(result.runnerUpConfidence).toBeGreaterThan(0.9);
    expect(result.runnerUpConfidence).toBeLessThan(result.confidence);
  });

  it('exposes bestProfileId for a near-miss even when it does not clear threshold', () => {
    const profiles = [profile({ id: 'p1', displayName: 'An', embeddings: [{ vector: A, meetingId: 'm1', durationSec: 10, createdAt: 'now' }] })];
    const result = matchSpeaker(B, profiles, 0.5);
    expect(result.profileId).toBeUndefined();
    expect(result.bestProfileId).toBe('p1');
    expect(result.runnerUpProfileId).toBeUndefined();
    expect(result.runnerUpConfidence).toBe(0);
  });

  it('matches per-embedding (max), not centroid — a profile with one close and one far embedding still matches', () => {
    const profiles = [
      profile({
        id: 'p1',
        displayName: 'An',
        embeddings: [
          { vector: A, meetingId: 'm1', durationSec: 10, createdAt: 'now' },
          { vector: B, meetingId: 'm2', durationSec: 10, createdAt: 'now' },
        ],
      }),
    ];
    const result = matchSpeaker(CLOSE_TO_A, profiles, 0.8);
    expect(result.profileId).toBe('p1');
  });
});
