import { describe, expect, it } from 'vitest';

import { ANCHOR_CAP, ANCHOR_MIN_DURATION_SEC, RECENT_CAP, SessionSpeakerCentroid } from './session-speaker-centroid.js';

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe('SessionSpeakerCentroid — fifo mode (today\'s behaviour)', () => {
  it('the first embedding is exempt and marked provisional, seeding the centroid', () => {
    const c = new SessionSpeakerCentroid('fifo');
    expect(c.isEmpty).toBe(true);
    const action = c.add(vec(1, 0), 5, { updateThreshold: 0.4 });
    expect(action).toBe('provisional');
    expect(c.centroid).toEqual(vec(1, 0));
    expect(c.isEmpty).toBe(false);
  });

  it('every later embedding folds in unconditionally (no anchors, no drift check) and the centroid is a plain mean', () => {
    const c = new SessionSpeakerCentroid('fifo');
    c.add(vec(1, 0), 5, { updateThreshold: 0.4 });
    const action = c.add(vec(0, 1), 5, { updateThreshold: 0.4 }); // orthogonal — would fail an anchor-drift check, but fifo has none
    expect(action).toBe('recent');
    expect(c.centroid![0]).toBeCloseTo(0.5);
    expect(c.centroid![1]).toBeCloseTo(0.5);
    expect(c.anchors).toHaveLength(0); // fifo mode never pins anchors
  });

  it(`caps the held window at ${RECENT_CAP}, evicting the oldest — reproduces the pre-split FIFO cap exactly`, () => {
    const c = new SessionSpeakerCentroid('fifo');
    for (let i = 1; i <= RECENT_CAP + 3; i++) c.add(vec(i, 0), 5, { updateThreshold: 0.4 });
    expect(c.recent).toHaveLength(RECENT_CAP);
    // Oldest 3 (values 1,2,3) evicted; held = [4..13] -> mean = 8.5.
    expect(c.centroid![0]).toBeCloseTo((4 + 13) / 2);
  });

  it('absorb() concatenates then caps at RECENT_CAP, keeping the most recently added (winner then loser, matching the pre-split merge order)', () => {
    const winner = new SessionSpeakerCentroid('fifo');
    for (let i = 0; i < 6; i++) winner.add(vec(1, 0), 5, { updateThreshold: 0.4 });
    const loser = new SessionSpeakerCentroid('fifo');
    for (let i = 0; i < 6; i++) loser.add(vec(0, 1), 5, { updateThreshold: 0.4 });

    winner.absorb(loser);
    // 6 + 6 = 12 > cap 10 -> the 2 OLDEST (winner's own first 2) are evicted, keeping winner's last 4 + loser's 6.
    expect(winner.recent).toHaveLength(RECENT_CAP);
    expect(winner.anchors).toHaveLength(0);
  });
});

describe('SessionSpeakerCentroid — anchors mode', () => {
  it('the first embedding is exempt/provisional; a later durSec>=4s embedding becomes the first pinned anchor, replacing the seed', () => {
    const c = new SessionSpeakerCentroid('anchors');
    expect(c.add(vec(1, 0), 5, { updateThreshold: 0.4 })).toBe('provisional');
    expect(c.isProvisional).toBe(true);
    expect(c.recent).toHaveLength(1);
    expect(c.anchors).toHaveLength(0);

    expect(c.add(vec(0.99, 0.14), ANCHOR_MIN_DURATION_SEC, { updateThreshold: 0.4 })).toBe('anchor');
    expect(c.isProvisional).toBe(false);
    expect(c.anchors).toHaveLength(1);
    expect(c.recent).toHaveLength(0); // the provisional seed is gone, not merely outweighed
    expect(c.centroid).toEqual(vec(0.99, 0.14));
  });

  it(`pins up to ${ANCHOR_CAP} anchors, never evicting them even as more turns arrive`, () => {
    const c = new SessionSpeakerCentroid('anchors');
    c.add(vec(1, 0), 5, { updateThreshold: 0.4 }); // provisional seed
    for (let i = 0; i < ANCHOR_CAP; i++) {
      const action = c.add(vec(1, 0), ANCHOR_MIN_DURATION_SEC, { updateThreshold: 0.4 });
      expect(action).toBe('anchor');
    }
    expect(c.anchors).toHaveLength(ANCHOR_CAP);

    // A 6th anchor-quality embedding no longer qualifies as an anchor (cap full) — falls through to the recent-window path.
    const overflow = c.add(vec(1, 0), ANCHOR_MIN_DURATION_SEC, { updateThreshold: 0.4 });
    expect(overflow).toBe('recent');
    expect(c.anchors).toHaveLength(ANCHOR_CAP); // still capped
  });

  it('a short (<4s) embedding never becomes an anchor even if it otherwise clears UPDATE — falls into recent instead', () => {
    const c = new SessionSpeakerCentroid('anchors');
    c.add(vec(1, 0), 5, { updateThreshold: 0.4 }); // provisional seed
    const action = c.add(vec(1, 0), 2, { updateThreshold: 0.4 }); // too short for an anchor
    expect(action).toBe('recent');
    expect(c.anchors).toHaveLength(0);
  });

  it('the anchor-drift check rejects an embedding that clears the OVERALL centroid but not the anchor-only centroid', () => {
    const c = new SessionSpeakerCentroid('anchors');
    c.add(vec(1, 0), 5, { updateThreshold: 0.4 }); // provisional seed
    c.add(vec(1, 0), ANCHOR_MIN_DURATION_SEC, { updateThreshold: 0.4 }); // first anchor, centroid=(1,0)

    // Too short to ever qualify as a 2nd anchor (durSec<4), so this falls to
    // the recent-window path — but cos((1,0), (0.3,0.9539)) = 0.3 < 0.4
    // against the (single) anchor centroid, so it never enters `recent` either.
    const rejected = c.add(vec(0.3, 0.9539), 2, { updateThreshold: 0.4 });
    expect(rejected).toBe('rejected-low-cos');
    expect(c.recent).toHaveLength(0);
    expect(c.centroid).toEqual(vec(1, 0)); // untouched
  });

  it('centroid is the duration-weighted mean over anchors ∪ recent', () => {
    const c = new SessionSpeakerCentroid('anchors');
    c.add(vec(1, 0), 5, { updateThreshold: 0.4 }); // provisional seed
    c.add(vec(1, 0), 20, { updateThreshold: 0.4 }); // anchor, weight 20 (durSec>=4)
    const recentAction = c.add(vec(0.6, 0.8), 2, { updateThreshold: 0.4 }); // too short for an anchor -> recent, weight 2
    expect(recentAction).toBe('recent');
    expect(c.anchors).toHaveLength(1);
    expect(c.recent).toHaveLength(1);

    // weight 20 on (1,0) + weight 2 on (0.6,0.8), total weight 22.
    const expectedX = (1 * 20 + 0.6 * 2) / 22;
    const expectedY = (0 * 20 + 0.8 * 2) / 22;
    expect(c.centroid![0]).toBeCloseTo(expectedX);
    expect(c.centroid![1]).toBeCloseTo(expectedY);
  });

  it('absorb() unions anchors capped at ANCHOR_CAP by LONGEST duration, and concatenates+caps recent', () => {
    const winner = new SessionSpeakerCentroid('anchors');
    winner.add(vec(1, 0), 5, { updateThreshold: 0.4 }); // seed
    winner.add(vec(1, 0), 20, { updateThreshold: 0.4 }); // winner anchor, duration 20

    const loser = new SessionSpeakerCentroid('anchors');
    loser.add(vec(0, 1), 5, { updateThreshold: 0.4 }); // seed
    loser.add(vec(0, 1), 8, { updateThreshold: 0.4 }); // loser anchor, duration 8

    winner.absorb(loser);
    expect(winner.anchors).toHaveLength(2);
    // Longest duration first (winner's 20s anchor still present).
    expect(winner.anchors[0].durSec).toBe(20);
    expect(winner.anchors[1].durSec).toBe(8);
  });

  it('fromRestoredCentroid rebuilds a single pinned anchor from a decrypted persisted centroid', () => {
    const c = SessionSpeakerCentroid.fromRestoredCentroid('anchors', vec(1, 0), 30);
    expect(c.anchors).toHaveLength(1);
    expect(c.anchors[0].durSec).toBe(30);
    expect(c.recent).toHaveLength(0);
    expect(c.centroid).toEqual(vec(1, 0));
    expect(c.isProvisional).toBe(false);
  });

  it('fromRestoredCentroid under fifo mode places the restored vector in the normal (evictable) recent window, not an anchor', () => {
    const c = SessionSpeakerCentroid.fromRestoredCentroid('fifo', vec(1, 0), 30);
    expect(c.anchors).toHaveLength(0);
    expect(c.recent).toHaveLength(1);
    expect(c.centroid).toEqual(vec(1, 0));
  });
});
