import { describe, expect, it } from 'vitest';

import {
  bucketFor,
  centroidTrials,
  falseMergeAt,
  falseSplitAt,
  farAt,
  frrAt,
  marginTrials,
  meanOf,
  meanVector,
  pairwiseScores,
  type Sample,
} from './calibration-metrics.js';

function sample(person: string, vector: number[], durationSec = 3): Sample {
  return { person, file: `${person}.wav`, vector: Float32Array.from(vector), durationSec };
}

describe('bucketFor', () => {
  it('buckets by the documented boundaries, and excludes anything under the 2s production floor', () => {
    expect(bucketFor(1.9)).toBeNull();
    expect(bucketFor(2)).toBe('2-3s');
    expect(bucketFor(2.9)).toBe('2-3s');
    expect(bucketFor(3)).toBe('3-5s');
    expect(bucketFor(4.9)).toBe('3-5s');
    expect(bucketFor(5)).toBe('>5s');
    expect(bucketFor(30)).toBe('>5s');
  });
});

describe('pairwiseScores', () => {
  it('splits same-person pairs into genuine and different-person pairs into impostor', () => {
    const samples = [sample('A', [1, 0]), sample('A', [0.9, 0.1]), sample('B', [0, 1])];
    const { genuine, impostor } = pairwiseScores(samples);
    expect(genuine).toHaveLength(1); // the two A/A pairs -> 1 pair
    expect(impostor).toHaveLength(2); // A1-B, A2-B
  });
});

describe('farAt / frrAt', () => {
  it('FAR counts impostor scores AT OR ABOVE the threshold; FRR counts genuine scores BELOW it', () => {
    expect(farAt([0.3, 0.6, 0.9], 0.5)).toBeCloseTo(2 / 3);
    expect(frrAt([0.3, 0.6, 0.9], 0.5)).toBeCloseTo(1 / 3);
  });

  it('an empty trial set reports 0 rather than dividing by zero', () => {
    expect(farAt([], 0.5)).toBe(0);
    expect(frrAt([], 0.5)).toBe(0);
  });
});

describe('falseMergeAt / falseSplitAt', () => {
  it('are aliases of FAR/FRR under the session-merge naming', () => {
    expect(falseMergeAt([0.7], 0.6)).toBe(farAt([0.7], 0.6));
    expect(falseSplitAt([0.3], 0.4)).toBe(frrAt([0.3], 0.4));
  });
});

describe('meanVector', () => {
  it('averages component-wise', () => {
    expect(meanVector([Float32Array.from([1, 0]), Float32Array.from([0, 1])])).toEqual(Float32Array.from([0.5, 0.5]));
  });
});

describe('centroidTrials', () => {
  it('needs >= 2*CENTROID_N (6) clips for a GENUINE trial, but only CENTROID_N (3) for an IMPOSTOR one', () => {
    const personA = Array.from({ length: 6 }, () => sample('A', [1, 0])); // exactly 2*CENTROID_N
    const personB = Array.from({ length: 3 }, () => sample('B', [0, 1])); // exactly CENTROID_N
    const { genuine, impostor } = centroidTrials([...personA, ...personB]);
    expect(genuine).toHaveLength(1); // A's own two non-overlapping centroids
    expect(impostor).toHaveLength(1); // A-vs-B centroid pair
  });

  it('a person with fewer than CENTROID_N clips contributes to neither genuine nor impostor', () => {
    const personA = [sample('A', [1, 0]), sample('A', [1, 0])]; // only 2, below CENTROID_N=3
    const personB = Array.from({ length: 3 }, () => sample('B', [0, 1]));
    const { genuine, impostor } = centroidTrials([...personA, ...personB]);
    expect(genuine).toHaveLength(0);
    expect(impostor).toHaveLength(0); // A has no centroid to pair with B's
  });
});

describe('marginTrials', () => {
  it('classifies a trial as genuine when the top-scoring person is the clip\'s own person', () => {
    const samples = [sample('A', [1, 0]), sample('A', [0.95, 0.05]), sample('B', [0, 1]), sample('B', [0.05, 0.95])];
    const { genuine, impostor } = marginTrials(samples);
    expect(genuine.length + impostor.length).toBe(samples.length);
    expect(impostor).toHaveLength(0); // each person's own clips score higher against each other than against the other person
  });

  it('a clip with fewer than 2 candidate people contributes no trial', () => {
    const samples = [sample('A', [1, 0])]; // only 1 person at all
    const { genuine, impostor } = marginTrials(samples);
    expect(genuine).toHaveLength(0);
    expect(impostor).toHaveLength(0);
  });
});

describe('meanOf', () => {
  it('averages a numeric array, NaN for empty', () => {
    expect(meanOf([1, 2, 3])).toBeCloseTo(2);
    expect(meanOf([])).toBeNaN();
  });
});
