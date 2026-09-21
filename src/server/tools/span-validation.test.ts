import { describe, expect, it } from 'vitest';

import { asChunkSegment, assertStructuralSpans, hasRealEnergy, isWithinPartWindow, MAX_SEGMENTS_PER_CHUNK } from './span-validation.js';

describe('asChunkSegment', () => {
  it('parses a valid segment', () => {
    expect(asChunkSegment({ speaker: 's0:1', startMs: 0, endMs: 1000, final: true })).toEqual({
      speaker: 's0:1',
      startMs: 0,
      endMs: 1000,
      final: true,
    });
  });

  it('rejects a missing speaker, non-finite times, or startMs >= endMs', () => {
    expect(asChunkSegment({ speaker: '', startMs: 0, endMs: 1000 })).toBeNull();
    expect(asChunkSegment({ speaker: 's0:1', startMs: 'x', endMs: 1000 })).toBeNull();
    expect(asChunkSegment({ speaker: 's0:1', startMs: 1000, endMs: 1000 })).toBeNull();
    expect(asChunkSegment({ speaker: 's0:1', startMs: -1, endMs: 1000 })).toBeNull();
  });
});

describe('assertStructuralSpans', () => {
  it('accepts a well-formed chunk', () => {
    expect(
      assertStructuralSpans(
        [
          { speaker: 's0:1', startMs: 0, endMs: 20_000, final: true },
          { speaker: 's0:2', startMs: 20_000, endMs: 40_000, final: true },
        ],
        60_000,
      ),
    ).toBeNull();
  });

  it('rejects more than MAX_SEGMENTS_PER_CHUNK turns', () => {
    const segments = Array.from({ length: MAX_SEGMENTS_PER_CHUNK + 1 }, (_, i) => ({ speaker: 's0:1', startMs: i, endMs: i + 1, final: true }));
    expect(assertStructuralSpans(segments, 60_000)).toMatch(/Too many turns/);
  });

  it('rejects two overlapping turns of the same speaker', () => {
    const segments = [
      { speaker: 's0:1', startMs: 0, endMs: 20_000, final: true },
      { speaker: 's0:1', startMs: 10_000, endMs: 30_000, final: true },
    ];
    expect(assertStructuralSpans(segments, 60_000)).toMatch(/overlap/);
  });

  it('allows overlap between DIFFERENT speakers', () => {
    const segments = [
      { speaker: 's0:1', startMs: 0, endMs: 20_000, final: true },
      { speaker: 's0:2', startMs: 5_000, endMs: 15_000, final: true },
    ];
    expect(assertStructuralSpans(segments, 60_000)).toBeNull();
  });

  it('rejects a total claimed duration far beyond durationMs', () => {
    const segments = [{ speaker: 's0:1', startMs: 0, endMs: 120_000, final: true }];
    expect(assertStructuralSpans(segments, 60_000)).toMatch(/exceeds/);
  });
});

describe('isWithinPartWindow', () => {
  it('accepts a span starting inside the window', () => {
    expect(isWithinPartWindow({ startMs: 61_000 }, 60_000, 60_000)).toBe(true);
  });

  it('accepts a span within tolerance of the window edges', () => {
    expect(isWithinPartWindow({ startMs: 58_600 }, 60_000, 60_000)).toBe(true); // 1.4s before window
  });

  it('rejects a span far outside the window (fabricated/hostile span)', () => {
    expect(isWithinPartWindow({ startMs: 500_000 }, 60_000, 60_000)).toBe(false);
  });
});

describe('hasRealEnergy', () => {
  it('rejects near-silent PCM', () => {
    expect(hasRealEnergy(new Float32Array(1600))).toBe(false);
  });

  it('accepts PCM with real signal', () => {
    const pcm = new Float32Array(1600).map((_, i) => Math.sin(i / 4) * 0.5);
    expect(hasRealEnergy(pcm)).toBe(true);
  });
});
